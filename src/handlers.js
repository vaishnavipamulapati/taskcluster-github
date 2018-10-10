const Debug = require('debug');
const taskcluster = require('taskcluster-client');
const libUrls = require('taskcluster-lib-urls');
const yaml = require('js-yaml');
const assert = require('assert');
const _ = require('lodash');
const prAllowed = require('./pr-allowed');

const INSPECTOR_URL = 'https://tools.taskcluster.net/task-group-inspector/#/';

const TITLES = { // maps github checkruns statuses and conclusions to titles to be displayed
  success: 'Success',
  failure: 'Failure',
  neutral: 'It is neither good nor bad',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  action_required: 'Action required',
  queued: 'Queued',
  in_progress: 'In progress',
  completed: 'Completed',
};

const CONCLUSIONS = { // maps queue exchange status to github checkrun conclusion
  completed: 'success',
  failed: 'failure',
  exception: 'failure',
};

const debugPrefix = 'taskcluster-github:handlers';
const debug = Debug(debugPrefix);

/**
 * Create handlers
 */
class Handlers {
  constructor({rootUrl, credentials, monitor, reference, jobQueueName, statusQueueName, intree, context}) {
    debug('Constructing handlers...');
    assert(monitor, 'monitor is required for statistics');
    assert(reference, 'reference must be provided');
    assert(rootUrl, 'rootUrl must be provided');
    assert(intree, 'intree configuration builder must be provided');
    this.rootUrl = rootUrl;
    this.credentials = credentials;
    this.monitor = monitor;
    this.reference = reference;
    this.intree = intree;
    this.connection = null;
    this.groupStatusListener = null;
    this.statusListener = null;
    this.jobListener = null;
    this.statusQueueName = statusQueueName;  // Optional
    this.jobQueueName = jobQueueName;  // Optional
    this.context = context;

    this.handlerComplete = null;
    this.handlerRejected = null;
  }

  /**
   * Set up the handlers.
   */
  async setup(options) {
    debug('Setting up handlers...');
    options = options || {};
    assert(!this.connection, 'Cannot setup twice!');
    this.connection = new taskcluster.PulseConnection(this.credentials);
    this.statusListener = new taskcluster.PulseListener({
      queueName: this.statusQueueName,
      connection: this.connection,
    });
    this.jobListener = new taskcluster.PulseListener({
      queueName: this.jobQueueName,
      connection: this.connection,
    });
    this.groupStatusListener = new taskcluster.PulseListener({
      queueName: this.statusQueueName,
      connection: this.connection,
    });

    // Listen for new jobs created via the api webhook endpoint
    let GithubEvents = taskcluster.createClient(this.reference);
    let githubEvents = new GithubEvents({rootUrl: this.rootUrl});
    await this.jobListener.bind(githubEvents.pullRequest());
    await this.jobListener.bind(githubEvents.push());
    await this.jobListener.bind(githubEvents.release());

    // Listen for state changes to the taskcluster tasks and taskgroups
    // We only need to listen for failure and exception events on
    // tasks. We wait for the entire group to be resolved before checking
    // for success.
    let queueEvents = new taskcluster.QueueEvents({rootUrl: this.rootUrl});
    let schedulerId = this.context.cfg.taskcluster.schedulerId;
    await this.statusListener.bind(queueEvents.taskFailed({schedulerId}));
    await this.statusListener.bind(queueEvents.taskException({schedulerId}));
    await this.statusListener.bind(queueEvents.taskCompleted({schedulerId}));

    await this.groupStatusListener.bind(queueEvents.taskGroupResolved({schedulerId}));

    const callHandler = (name, handler) => message => {
      handler.call(this, message).catch(async err => {
        debug(`Error (reported to sentry) while calling ${name} handler: ${err}`);
        await this.monitor.reportError(err);
        return err;
      }).then((err=null) => {
        if (this.handlerComplete && !err) {
          this.handlerComplete();
        } else if (this.handlerRejected && err) {
          this.handlerRejected(err);
        }
      });
    };

    this.jobListener.on('message',
      this.monitor.timedHandler('joblistener', callHandler('job', jobHandler)));
    this.statusListener.on('message',
      this.monitor.timedHandler('statuslistener', callHandler('status', statusHandler)));
    this.groupStatusListener.on('message',
      this.monitor.timedHandler('groupStatuslistener', callHandler('status', groupStatusHandler)));

    // If this is awaited, it should return [undefined, undefined]
    await Promise.all([this.jobListener.resume(), this.statusListener.resume(), this.groupStatusListener.resume()]);
  }

  async terminate() {
    debug('Terminating handlers...');
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  // Create a collection of tasks, centralized here to enable testing without creating tasks.
  async createTasks({scopes, tasks}) {
    let queue = new taskcluster.Queue({
      rootUrl: this.context.cfg.taskcluster.rootUrl,
      credentials: this.context.cfg.taskcluster.credentials,
      authorizedScopes: scopes,
    });
    await Promise.all(tasks.map(t => queue.createTask(t.taskId, t.task)));
  }

  // Send an exception to Github in the form of a comment.
  async createExceptionComment({instGithub, organization, repository, sha, error, pullNumber}) {
    let errorBody = error.body && error.body.error || error.message;
    // Let's prettify any objects
    if (typeof errorBody == 'object') {
      errorBody = JSON.stringify(errorBody, null, 4);
    }
    let body = [
      '<details>\n',
      '<summary>Submitting the task to Taskcluster failed. Details</summary>',
      '',
      errorBody, // already in Markdown..
      '',
      '</details>',
    ].join('\n') ;

    // Warn the user know that there was a problem handling their request
    // by posting a comment; this error is then considered handled and not
    // reported to the taskcluster team or retried
    if (pullNumber) {
      debug(`creating exception comment on ${organization}/${repository}#${pullNumber}`);
      await instGithub.issues.createComment({
        owner: organization,
        repo: repository,
        number: pullNumber,
        body,
      });
      return;
    }
    debug(`creating exception comment on ${organization}/${repository}@${sha}`);
    await instGithub.repos.createCommitComment({
      owner: organization,
      repo: repository,
      sha,
      body,
    });
  }
}
module.exports = Handlers;

/**
 * Modify the build in the Azure table when the taskgroup is resolved
 *
 * @param exchange message from Queue service
 * @returns {Promise<void>}
 */
async function groupStatusHandler(message) {
  let taskGroupId = message.payload.taskGroupId;

  let build = await this.context.Builds.load({
    taskGroupId,
  });

  let debug = Debug(debugPrefix + ':' + build.eventId);
  debug(`Handling state change for task-group ${taskGroupId}`);

  let groupState = 'success';

  let queue = new taskcluster.Queue({
    rootUrl: this.context.cfg.taskcluster.rootUrl,
  });
  let params = {};
  do {
    let group = await queue.listTaskGroup(taskGroupId, params);
    params.continuationToken = group.continuationToken;
    group.tasks.forEach(task => {
      if (_.includes(['failed', 'exception'], task.status.state)) {
        groupState = 'failure';
      }
    });
  } while (params.continuationToken);

  await build.modify(b => {
    if (b.state !== 'failure') {
      b.state = groupState;
      b.updated = new Date();
    }
  });
}

/**
 * Post updates to GitHub, when the status of a task changes.
 * Taskcluster States:
 * GitHub Checks: https://developer.github.com/v3/checks/
 **/
async function statusHandler(message) {
  let taskGroupId = message.payload.status.taskGroupId;
  let taskId = message.payload.status.taskId;

  let build = await this.context.Builds.load({
    taskGroupId,
  });

  let debug = Debug(debugPrefix + ':' + build.eventId);
  debug(`Handling state change for task ${taskId} in group ${taskGroupId}`);

  let taskState = {
    status: 'completed',
    conclusion: CONCLUSIONS[message.payload.status.state],
    completed_at: new Date().toISOString(),
  };

  let checkRun = await this.context.CheckRuns.load({taskGroupId, taskId});

  // Authenticating as installation.
  try {
    debug('Authenticating as installation in status handler...');
    var instGithub = await this.context.github.getInstallationGithub(build.installationId);
    debug('Authorized as installation in status handler');
  } catch (e) {
    debug(`Error authenticating as installation in status handler! Error: ${e}`);
    throw e;
  }

  debug(`Attempting to update status for ${build.organization}/${build.repository}@${build.sha} (${taskState})`);
  try {
    await instGithub.checks.update(Object.assign(
      {
        owner: build.organization,
        repo: build.repository,
        check_run_id: checkRun.checkRunId,
      },
      taskState
    ));
  } catch (e) {
    debug(`Failed to update status: ${build.organization}/${build.repository}@${build.sha}`);
    throw e;
  }
}

/**
 * If a .taskcluster.yml exists, attempt to turn it into a taskcluster
 * graph config, and submit it to the scheduler.
 **/
async function jobHandler(message) {
  let debug = Debug(debugPrefix + ':' + message.payload.eventId);
  debug('Received message. Starting processing...');
  let context = this.context;

  // Authenticating as installation.
  let instGithub = await context.github.getInstallationGithub(message.payload.installationId);

  // We must attempt to convert the sanitized fields back to normal here. 
  // Further discussion of how to deal with this cleanly is in
  // https://github.com/taskcluster/taskcluster-github/issues/52
  message.payload.organization = message.payload.organization.replace(/%/g, '.');
  message.payload.repository = message.payload.repository.replace(/%/g, '.');
  let organization = message.payload.organization;
  let repository = message.payload.repository;
  let sha = message.payload.details['event.head.sha'];
  let pullNumber = message.payload.details['event.pullNumber'];
  if (!sha) {
    debug('Trying to get commit info in job handler...');
    let commitInfo = await instGithub.repos.getShaOfCommitRef({
      owner: organization,
      repo: repository,
      ref: `refs/tags/${message.payload.details['event.version']}`,
    });
    sha = commitInfo.data.sha;
  }

  debug(`handling ${message.payload.details['event.type']} webhook for: ${organization}/${repository}@${sha}`);
  let repoconf = undefined;

  // Try to fetch a .taskcluster.yml file for every request
  try {
    debug('Trying to fetch the YML...');
    let tcyml = await instGithub.repos.getContent({
      owner: organization,
      repo: repository,
      path: '.taskcluster.yml',
      ref: sha,
    });
    repoconf = new Buffer(tcyml.data.content, 'base64').toString();
  } catch (e) {
    if (e.code === 404) {
      debug(`${organization}/${repository} has no '.taskcluster.yml'. Skipping.`);
      return;
    }
    if (_.endsWith(e.message, '</body>\n</html>\n') && e.message.length > 10000) {
      // We kept getting full html 500/400 pages from github in the logs.
      // I consider this to be a hard-to-fix bug in octokat, so let's make
      // the logs usable for now and try to fix this later. It's a relatively
      // rare occurence.
      debug('Detected an extremeley long error. Truncating!');
      e.message = _.join(_.take(e.message, 100).concat('...'), '');
      e.stack = e.stack.split('</body>\n</html>\n')[1] || e.stack;
    }
    throw e;
  }

  // Check if this is meant to be built by tc-github at all.
  // This is a bit of a hack, but is needed for bug 1274077 for now
  try {
    let c = yaml.safeLoad(repoconf);
  } catch (e) {
    if (e.name === 'YAMLException') {
      return await this.createExceptionComment({instGithub, organization, repository, sha, error: e, pullNumber});
    }
    throw e;
  }

  let groupState = {
    status: 'queued',
  };
  let taskGroupId = 'nonexistent';
  let graphConfig;

  // Now we can try processing the config and kicking off a task.
  try {
    graphConfig = this.intree({
      config: repoconf,
      payload: message.payload,
      validator: context.validator,
      schema: {
        0: libUrls.schema(this.rootUrl, 'github', 'v1/taskcluster-github-config.yml'),
        1: libUrls.schema(this.rootUrl, 'github', 'v1/taskcluster-github-config.v1.yml'),
      },
    });
    if (graphConfig.tasks.length === 0) {
      debug(`intree config for ${organization}/${repository} compiled with zero tasks. Skipping.`);
      return;
    }
  } catch (e) {
    debug('.taskcluster.yml was not formatted correctly. Leaving comment on Github.');
    await this.createExceptionComment({instGithub, organization, repository, sha, error: e, pullNumber});
    return;
  }

  if (message.payload.details['event.type'].startsWith('pull_request.')) {
    debug('Checking pull request permission...');

    // Decide if a user has permissions to run tasks.
    let login = message.payload.details['event.head.user.login'];
    try {
      if (!await prAllowed({login, organization, repository, instGithub, debug, message})) {
        let body = [
          '<details>\n',
          '<summary>No Taskcluster jobs started for this pull request</summary>\n\n',
          '```js\n',
          'The `allowPullRequests` configuration for this repository (in `.taskcluster.yml` on the',
          'default branch) does not allow starting tasks for this pull request.',
          '```\n',
          '</details>',
        ].join('\n');
        await instGithub.issues.createComment({
          owner: organization,
          repo: repository,
          number: pullNumber,
          body,
        });
        return;
      }
    } catch (e) {
      if (e.name === 'YAMLException') {
        let docsLink = 'https://docs.taskcluster.net/reference/integrations/github/docs/usage#who-can-trigger-jobs';
        await instGithub.issues.createComment({
          owner: organization,
          repo: repository,
          number: pullNumber,
          body: [
            '<details>\n',
            '<summary>Error in `.taskcluster.yml` while checking',
            'for permissions **on default branch ' + branch + '**.',
            'Read more about this in',
            '[the taskcluster docs](' + docsLink + ').',
            'Details:</summary>\n\n',
            '```js\n',
            e.message,
            '```\n',
            '</details>',
          ].join('\n'),
        });
        return;
      }
      throw e;
    }
  }

  try {
    taskGroupId = graphConfig.tasks[0].task.taskGroupId;
    debug(`Creating tasks. (taskGroupId: ${taskGroupId})`);
    await this.createTasks({scopes: graphConfig.scopes, tasks: graphConfig.tasks});
  } catch (e) {
    debug('Creating tasks failed! Leaving comment on Github.');
    groupState = {
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
    };
    await this.createExceptionComment({instGithub, organization, repository, sha, error: e});
  } finally {
    debug(`Trying to create check runs for ${organization}/${repository}@${sha} (${groupState})`);
    let eventType = message.payload.details['event.type'];

    await Promise.all(graphConfig.tasks.map(async (task, i) => {
      const checkRun = await instGithub.checks.create(Object.assign( // TODO: need spread syntax
        {
          owner: organization,
          repo: repository,
          name: `Task ${i}: ${this.context.cfg.app.statusContext} (${eventType.split('.')[0]})`,
          head_sha: sha,
          output: { // TODO: maybe a more helpful output?
            title: `TaskGroup: ${groupState.conclusion // TODO: we're using group status for individual task
              ? TITLES[groupState.conclusion]
              : TITLES[groupState.status]} (for ${eventType})`,
            summary: `Check for ${eventType}`,
          },
          details_url: INSPECTOR_URL + taskGroupId + `/tasks/${task.taskId}/details`,
        },
        groupState, // TODO: we're using group status for individual task
      ));

      return await context.CheckRuns.create({
        taskGroupId: taskGroupId,
        taskId: task.taskId,
        checkSuiteId: checkRun.data.check_suite.id.toString(),
        checkRunId: checkRun.data.id.toString(),
      }).catch(async (err) => {
        if (err.code !== 'EntityAlreadyExists') {
          throw err;
        }
      });
    }));

    let now = new Date();
    let state = groupState.conclusion || groupState.status;
    await context.Builds.create({
      organization,
      repository,
      sha,
      taskGroupId,
      state,
      created: now,
      updated: now,
      installationId: message.payload.installationId,
      eventType: message.payload.details['event.type'],
      eventId: message.payload.eventId,
    }).catch(async (err) => {
      if (err.code !== 'EntityAlreadyExists') {
        throw err;
      }
      let build = await this.Builds.load({
        taskGroupId,
      });
      assert.equal(build.state, state, `State for ${organization}/${repository}@${sha}
        already exists but is set to ${build.state} instead of ${state}!`);
      assert.equal(build.organization, organization);
      assert.equal(build.repository, repository);
      assert.equal(build.sha, sha);
      assert.equal(build.eventType, message.payload.details['event.type']);
      assert.equal(build.eventId, message.payload.eventId);
    });
  }
}


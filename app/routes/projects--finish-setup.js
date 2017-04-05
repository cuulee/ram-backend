'use strict';
import Joi from 'joi';
import Boom from 'boom';
import Promise from 'bluebird';

import db from '../db/';
import { ProjectNotFoundError, DataConflictError } from '../utils/errors';
import { getProject } from './projects--get';
import Operation from '../utils/operation';

import { fork } from 'child_process';
import path from 'path';

module.exports = [
  {
    path: '/projects/{projId}/finish-setup',
    method: 'POST',
    config: {
      validate: {
        params: {
          projId: Joi.number()
        },
        payload: {
          scenarioName: Joi.string().required(),
          scenarioDescription: Joi.string()
        }
      }
    },
    handler: (request, reply) => {
      getProject(request.params.projId)
        .then(project => {
          if (project.status !== 'pending') {
            throw new DataConflictError('Project setup already completed');
          }
          if (!project.readyToEndSetup) {
            throw new DataConflictError('Project preconditions to finish setup not met');
          }
        })
        .then(() => db('scenarios')
          .select('*')
          .where('project_id', request.params.projId)
          .where('master', true)
          .first()
        )
        .then(scenario => {
          let projId = scenario.project_id;
          let scId = scenario.id;
          let {scenarioName, scenarioDescription} = request.payload;

          return db.transaction(function (trx) {
            return Promise.all([
              trx('projects')
                .update({
                  updated_at: (new Date())
                })
                .where('id', projId),
              trx('scenarios')
                .update({
                  name: scenarioName,
                  description: typeof scenarioDescription === 'undefined' ? '' : scenarioDescription,
                  updated_at: (new Date())
                })
                .where('id', scId)
            ]);
          })
          .then(() => startOperation(projId, scId)
            .then(op => startFinishSetupProcess(op.getId(), projId, scId))
          );
        })
        .then(() => reply({statusCode: 200, message: 'Project setup finish started'}))
        .catch(ProjectNotFoundError, e => reply(Boom.notFound(e.message)))
        .catch(DataConflictError, e => reply(Boom.conflict(e.message)))
        .catch(err => {
          console.log('err', err);
          reply(Boom.badImplementation(err));
        });
    }
  }
];

function startOperation (projId, scId) {
  let op = new Operation(db);
  return op.loadByData('project-setup-finish', projId, scId)
    .then(op => {
      if (op.isStarted()) {
        throw new DataConflictError('Project finish setup already in progress');
      }
    }, err => {
      // In this case if the operation doesn't exist is not a problem.
      if (err.message.match(/not exist/)) { return; }
      throw err;
    })
    .then(() => {
      let op = new Operation(db);
      return op.start('project-setup-finish', projId, scId)
        .then(() => op.log('start', {message: 'Process starting'}));
    });
}

function startFinishSetupProcess (opId, projId, scId) {
  // In test mode we don't want to start the script.
  // It will be tested in the appropriate place.
  if (process.env.DS_ENV === 'test') { return; }

  const p = fork(path.resolve(__dirname, '../services/project-setup/index.js'));
  let processError = null;

  p.send({opId: opId, projId, scId});

  p.on('message', function (msg) {
    switch (msg.type) {
      case 'error':
        processError = msg;
        break;
    }
  });

  p.on('exit', (code) => {
    if (code !== 0) {
      processError = processError || `Unknown error. Code ${code}`;
      // The operation may not have finished if the error took place outside
      // the promise, or if the error was due to a wrong db connection.
      let op = new Operation(db);
      op.loadById(opId)
        .then(op => {
          if (!op.isCompleted()) {
            return op.log('error', {error: processError})
              .then(op => op.finish());
          }
        });
    }
  });
}

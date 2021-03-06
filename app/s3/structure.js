'use strict';
import Promise from 'bluebird';

import s3, { bucket, region } from './';
import config from '../config';

const DEBUG = config.debug;
const BUCKET = bucket;
const REGION = region;

export function listObjects (bucket, objPrefix = '') {
  return new Promise((resolve, reject) => {
    var objects = [];
    var stream = s3.listObjectsV2(bucket, objPrefix, true);
    stream.on('data', obj => {
      objects.push(obj);
    });
    stream.on('error', err => {
      return reject(err);
    });
    stream.on('end', () => {
      return resolve(objects);
    });
  });
}

export function emptyBucket (bucket, objPrefix = '') {
  return listObjects(bucket, objPrefix)
    .catch(err => {
      if (err.code === 'NoSuchBucket') {
        return [];
      }
      throw err;
    })
    .then(objects => Promise.map(objects, o => removeObject(bucket, o.name), { concurrency: 10 }));
}

export function destroyBucket (bucket) {
  return emptyBucket(bucket)
    .then(() => removeBucket(bucket));
}

export function createBucket (bucket, region) {
  return new Promise((resolve, reject) => {
    s3.makeBucket(bucket, region, err => {
      if (err) {
        if (err.code === 'BucketAlreadyOwnedByYou') {
          DEBUG && console.log(`Bucket ${bucket} already exists`);
        } else {
          return reject(err);
        }
      }
      DEBUG && console.log(`Bucket ${bucket} created`);
      return resolve({bucket, region});
    });
  });
}

export function setupStructure () {
  return destroyBucket(BUCKET)
    .then(() => createBucket(BUCKET, REGION));
}

export function removeObject (bucket, name) {
  return new Promise((resolve, reject) => {
    s3.removeObject(bucket, name, err => {
      if (err) {
        return reject(err);
      }
      return resolve();
    });
  });
}

function removeBucket (bucket) {
  return new Promise((resolve, reject) => {
    s3.removeBucket(bucket, err => {
      if (err) {
        if (err.code === 'NoSuchBucket') {
          DEBUG && console.log(`Bucket ${bucket} does not exist. Skipping deletion`);
        } else {
          return reject(err);
        }
      }
      DEBUG && console.log(`Bucket ${bucket} deleted`);
      return resolve();
    });
  });
}

export function putObjectFromFile (bucket, name, filepath) {
  return new Promise((resolve, reject) => {
    s3.fPutObject(bucket, name, filepath, 'application/octet-stream', (err, etag) => {
      if (err) {
        return reject(err);
      }
      return resolve(etag);
    });
  });
}

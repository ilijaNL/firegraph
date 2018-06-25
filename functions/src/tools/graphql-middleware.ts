import {
  GraphQLOptions,
  HttpQueryError,
  runHttpQuery
} from 'apollo-server-core';
import * as express from 'express';
import {
  ExpressGraphQLOptionsFunction,
  ExpressHandler
} from 'apollo-server-express';
import * as LRU from 'lru-cache';
import * as sha256 from 'hash.js/lib/hash/sha/256';

interface PersistQuery {
  version: string;
  sha256Hash: string;
}

// create cache
// TODO determine perfect size
const lruCache = LRU<string, any>(150);

const isPersistedQuery = (data): PersistQuery => {
  if (data.extensions) {
    const payload = JSON.parse(data.extensions);

    return payload.persistedQuery;
  }

  return null;
};

const hashPostBody = query =>
  sha256()
    .update(query)
    .digest('hex');

const getCacheKey = (query: PersistQuery) => {
  return `${query.version}.${query.sha256Hash}`;
};

const removeExtensions = (obj: string) => {
  const cachedValue = JSON.parse(obj);
  delete cachedValue.extensions;
  return JSON.stringify(cachedValue);
};

const sendContent = (res, value) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(value, 'utf8').toString());
  res.write(value);
  res.end();
};

export const getFromCacheIfAny = (
  req: express.Request,
  res: express.Response,
  next
) => {
  const { method } = req;
  const data = req.method === 'POST' ? req.body : req.query;
  const pQuery = isPersistedQuery(data);

  //check if in cache if get method
  if (method === 'POST' && data.query && lruCache.has(hashPostBody(data))) {
    res.setHeader('X-Cache', 'HIT');
    const { data: cachedData } = lruCache.get(hashPostBody(data));
    sendContent(res, cachedData);
  } else if (method === 'GET' && pQuery && lruCache.has(getCacheKey(pQuery))) {
    console.log('FROM CACHE');
    const { data: cachedData, at, duration } = lruCache.get(
      getCacheKey(pQuery)
    );
    const durationLeft = Math.round(duration / 1000 - (Date.now() - at) / 1000);
    res.setHeader('X-Cache', 'HIT');
    // set firebase CDN cache
    res.setHeader(
      'Cache-Control',
      `public, max-age=${durationLeft}, s-maxage=${durationLeft}`
    );
    sendContent(res, cachedData);
  } else if (method === 'GET' && pQuery && !data.query) {
    // we trying to cache, but don't have in cache so send error header so apollo client understands
    res.statusCode = 200;
    res.write(
      JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] })
    );
    res.end();
  } else {
    next();
  }
};

export const storeInCache = (
  req: express.Request,
  res: express.Response,
  next
) => {
  const { method } = req;
  const data = req.method === 'POST' ? req.body : req.query;
  const pQuery = isPersistedQuery(data);
  if ((method === 'GET' && pQuery) || (method === 'POST' && data.query)) {
    // get extensions cache duration
    const extensions = JSON.parse(res['gqlResponse']).extensions;
    // only cache if cache control is enabled
    if (extensions && extensions.cacheControl) {
      const minAge = extensions.cacheControl.hints.reduce(
        (min, p) => (p.maxAge < min ? p.maxAge : min),
        60
      );

      console.log('SET-CACHE For', minAge * 1000);

      lruCache.set(
        method === 'GET' ? getCacheKey(pQuery) : hashPostBody(data), // get hash key from input
        {
          data: removeExtensions(res['gqlResponse']),
          at: Date.now(),
          duration: minAge * 1000
        },
        minAge === 0 ? 1 * 1000 : minAge * 1000 // store for 1 second if minAge is not defined (bug in lruCache)
      );
      res.setHeader('X-Cache', 'MISS');
    }
  }

  next();
};

export const extensionsFilter = (
  req: express.Request,
  res: express.Response,
  next
) => {
  res['gqlResponse'] = removeExtensions(res['gqlResponse']);
  next();
};

export const graphqlResponseHandler = (
  req: express.Request,
  res: express.Response,
  next
) => {
  sendContent(res, res['gqlResponse']);
};

export function graphqlExpress(
  options: GraphQLOptions | ExpressGraphQLOptionsFunction
): ExpressHandler {
  if (!options) {
    throw new Error('Apollo Server requires options.');
  }

  if (arguments.length > 1) {
    // TODO: test this
    throw new Error(
      `Apollo Server expects exactly one argument, got ${arguments.length}`
    );
  }

  const graphqlHandler = (
    req: express.Request,
    res: express.Response,
    next
  ): void => {
    runHttpQuery([req, res], {
      method: req.method,
      options: options,
      query: req.method === 'POST' ? req.body : req.query
    }).then(
      gqlResponse => {
        res['gqlResponse'] = gqlResponse;
        next();
      },
      (error: HttpQueryError) => {
        if ('HttpQueryError' !== error.name) {
          return next(error);
        }

        if (error.headers) {
          Object.keys(error.headers).forEach(header => {
            res.setHeader(header, error.headers[header]);
          });
        }
        res.statusCode = error.statusCode;
        res.write(error.message);
        res.end();
      }
    );
  };

  return graphqlHandler;
}

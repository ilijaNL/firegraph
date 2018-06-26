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

export interface KeyValueCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, duration?: number): Promise<void>;
}

// size: 50 mb default
export const createLRUCache = (
  options: { size: number } = { size: 50000000 }
): KeyValueCache => {
  // create cache
  console.log('creating cache with size', options.size);
  const cache = LRU<string, string>({
    max: options.size,
    length: (n, key) => n.length + key.length
  });

  return {
    async get(key) {
      return cache.get(key);
    },
    async set(key, value, maxAge) {
      if (maxAge) {
        cache.set(key, value, maxAge);
      } else {
        cache.set(key, value);
      }
    }
  };
};
const isPersistedQuery = (data): PersistQuery => {
  if (data.extensions) {
    const payload = JSON.parse(data.extensions);

    return payload.persistedQuery;
  }

  return null;
};

const hashPostBody = (query: string) => {
  // trim query
  const q = query.replace(/\s+/g, '');
  const key = sha256()
    .update(q)
    .digest('hex');

  console.log(q, key);
  return key;
};

const extractCacheKey = (query: PersistQuery) => {
  return `${query.version}.${query.sha256Hash}`;
};

const removeExtensions = (obj: string) => {
  const cachedValue = JSON.parse(obj);
  delete cachedValue.extensions;
  return JSON.stringify(cachedValue);
};

const sendContent = (
  res: express.Response,
  value: string,
  cacheHit = false
) => {
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(value, 'utf8').toString());
  res.write(value);
  res.end();
};

export const getFromCacheIfAny = (store: KeyValueCache) => async (
  req: express.Request,
  res: express.Response,
  next
) => {
  const { method } = req;
  const data = req.method === 'POST' ? req.body : req.query;
  const pQuery = isPersistedQuery(data);

  // server side cache only
  if (method === 'POST' && data.query) {
    // just normal post request
    const value = await store.get(hashPostBody(data.query));
    if (value) {
      const { payload } = JSON.parse(value);
      sendContent(res, payload, true);
      return;
    }
  } else if (method === 'GET' && pQuery) {
    // in case of Automatic Persisted Queries
    const value = await store.get(extractCacheKey(pQuery));

    if (value) {
      const { duration, at, payload } = JSON.parse(value);
      const durationLeft = Math.round(
        duration / 1000 - (Date.now() - at) / 1000
      );

      // set CDN caching
      res.setHeader(
        'Cache-Control',
        `public, max-age=${durationLeft}, s-maxage=${durationLeft}`
      );

      sendContent(res, payload, true);
      return;
    }
  }

  if (method === 'GET' && pQuery && !data.query) {
    sendContent(
      res,
      JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] })
    );
    return;
  }

  next();
};

export const storeInCache = (store: KeyValueCache) => async (
  req: express.Request,
  res: express.Response,
  next
) => {
  const { method } = req;
  const data = req.method === 'POST' ? req.body : req.query;
  const pQuery = isPersistedQuery(data);
  if ((method === 'GET' && pQuery) || (method === 'POST' && data.query)) {
    const gqlData = res['gqlResponse'];
    // get extensions cache duration
    const extensions = JSON.parse(gqlData).extensions;
    // only cache if cache control is enabled
    if (extensions && extensions.cacheControl) {
      const minAge = extensions.cacheControl.hints.reduce(
        (min, p) => (p.maxAge < min ? p.maxAge : min),
        60
      );

      const minAgeInMs = minAge * 1000;

      console.log('SET-CACHE For', minAgeInMs);

      const key =
        method === 'GET' ? extractCacheKey(pQuery) : hashPostBody(data.query);
      await store.set(
        key,
        JSON.stringify({
          payload: removeExtensions(gqlData),
          at: Date.now(),
          duration: minAgeInMs
        }),
        minAgeInMs
      );
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

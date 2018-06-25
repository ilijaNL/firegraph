import * as express from 'express';
import { graphiqlExpress } from 'apollo-server-express';
import {
  graphqlExpress,
  graphqlResponseHandler,
  extensionsFilter,
  getFromCacheIfAny,
  storeInCache
} from './tools/graphql-middleware';
import { makeExecutableSchema } from 'graphql-tools';
import * as bodyParser from 'body-parser';

// Some fake data
const books = [
  {
    title: "Harry Potter and the Sorcerer's stone",
    author: 'J.K. Rowling',
    date: () => Date.now()
  },
  {
    title: 'Jurassic Park',
    author: 'Michael Crichton',
    date: () => Date.now()
  }
];

// The GraphQL schema in string form
const typeDefs = `
  type Query { books: [Book] }
  type Book @cacheControl(maxAge: 65) { title: String, author: String, date: String }
`;

// The resolvers
const resolvers = {
  Query: { books: () => books }
};

// Put together a schema
const schema = makeExecutableSchema({
  typeDefs,
  resolvers
});

// Initialize the app
const app = express();

console.log(process.env.LOCAL_DEBUG);

const giqlExp = graphiqlExpress({
  endpointURL: process.env.LOCAL_DEBUG === 'watch' ? '/graphql' : '/api/graphql'
});

// GraphiQL, a visual editor for queries
app.use('/graphiql', giqlExp);

// The GraphQL endpoint
const gExpress = graphqlExpress({
  schema, // Add the two options below
  tracing: true,
  cacheControl: {
    defaultMaxAge: 60 // cache for 1 minute
  }
});

// firebase does bodyparsing out of the box, so only local
if (process.env.LOCAL_DEBUG === 'watch') {
  app.use('/graphql', bodyParser.json());
}

app.use(
  '/graphql',
  // checks the cache
  getFromCacheIfAny,
  // get response from graphql-server if not in cache
  gExpress,
  // store in cache if it is a get/post query request
  storeInCache,
  // filter out the extensions
  extensionsFilter,
  // send the response
  graphqlResponseHandler
);

export { app };

import * as functions from 'firebase-functions';
import { lazyModule } from './tools/importer';

export const api = functions.https.onRequest(async (request, response) => {
  // lazy import for faster cold starts
  const { app } = await lazyModule(__dirname + '/server');
  app(request, response);
});

import { completeQueuedExports } from '../apps/api/dist/storage.js';

const result = completeQueuedExports();
console.log(JSON.stringify(result, null, 2));

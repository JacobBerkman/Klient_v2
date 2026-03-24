import { completeQueuedExports } from '../apps/api/src/storage.mjs';

const result = completeQueuedExports();
console.log(JSON.stringify(result, null, 2));

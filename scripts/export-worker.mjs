import { createStore } from '../apps/api/src/store.mjs';

const store = createStore();
const result = await store.processQueuedExports();
console.log(JSON.stringify(result, null, 2));

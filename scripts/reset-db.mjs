import { createSeedState } from '../apps/api/src/store.mjs';
import { resetState } from '../apps/api/src/storage.mjs';

const result = resetState(createSeedState);
console.log(JSON.stringify(result, null, 2));

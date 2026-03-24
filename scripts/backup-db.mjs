import { backupState } from '../apps/api/src/storage.mjs';

const result = backupState();
console.log(JSON.stringify(result, null, 2));

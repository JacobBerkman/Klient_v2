import { backupState } from '../apps/api/dist/storage.js';

const result = backupState();
console.log(JSON.stringify(result, null, 2));

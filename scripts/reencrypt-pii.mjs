import { createStore } from '../apps/api/src/store.mjs';

const store = createStore();
const actorUserId = process.env.PII_ROTATION_ACTOR_USER_ID || 'system';
const firmId = process.env.PII_ROTATION_FIRM_ID || null;

const result = store.reencryptSensitiveData({ actorUserId, firmId });
console.log(JSON.stringify({ ok: true, ...result }, null, 2));

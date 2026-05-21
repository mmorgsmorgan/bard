import Database from 'better-sqlite3';
const db = new Database('./data/bard.db');
db.pragma('foreign_keys = OFF');
db.exec('DELETE FROM endorsements');
db.exec('DELETE FROM contributions');
db.exec('DELETE FROM agents');
try { db.exec('DELETE FROM agent_verifications'); } catch(e) {}
db.pragma('foreign_keys = ON');
console.log('Agents:', db.prepare('SELECT COUNT(*) as c FROM agents').get().c);
console.log('Contributions:', db.prepare('SELECT COUNT(*) as c FROM contributions').get().c);
console.log('Endorsements:', db.prepare('SELECT COUNT(*) as c FROM endorsements').get().c);
console.log('Done — all demo data cleared.');
db.close();

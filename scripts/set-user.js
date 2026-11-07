// Create or update one of the two Hubb accounts.
// Usage: node scripts/set-user.js <username> <password> "<Display name>"
const [, , username, password, name] = process.argv;
if (!username || !password) {
  console.log('Usage: node scripts/set-user.js <username> <password> "<Display name>"');
  process.exit(1);
}
try {
  const { setUser } = require('../server.js');
  console.log(`Account ${username}: ${setUser(username, password, name)}`);
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

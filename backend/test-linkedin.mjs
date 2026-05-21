const res = await fetch('http://localhost:4000/api/profiles', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    wallet: '0xtest123', username: 'testuser', displayName: 'Test User',
    bio: 'Builder and creator', profileType: 'human', ecosystems: ['Arc'],
    farcaster: '', github: 'testgit', x: '@testx',
    discord: 'test#1234', linkedin: 'in/testlinkedin',
    createdAt: '2026-01-01',
  }),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
// Verify linkedin is saved
if (data.profile?.linkedin === 'in/testlinkedin') {
  console.log('\n✅ LinkedIn field saved correctly');
} else {
  console.log('\n❌ LinkedIn field missing or wrong:', data.profile?.linkedin);
}

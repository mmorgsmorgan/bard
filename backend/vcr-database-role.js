// Run only with the API's database owner connection, after schema bootstrap.
// The verifier gets policy access, never wallet keys or agent credentials.
export async function provisionVerifierRole(pool, { password, schema = 'public' }) {
  if (!/^[a-f0-9]{64}$/.test(password || '') || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('A valid private VCR database password and schema are required.');
  }
  const namespace = '"' + schema + '"';
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('bard:vcr-database-role',0))");
    await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bard_vcr') THEN CREATE ROLE bard_vcr; END IF; END $$");
    // The password is validated hexadecimal; it cannot inject SQL. Never log
    // this query or include its contents in a surfaced provisioning failure.
    await db.query("ALTER ROLE bard_vcr WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '" + password + "'");
    await db.query('REVOKE ALL ON ALL TABLES IN SCHEMA ' + namespace + ' FROM bard_vcr');
    await db.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ' + namespace + ' FROM bard_vcr');
    await db.query('GRANT USAGE ON SCHEMA ' + namespace + ' TO bard_vcr');
    await db.query('GRANT SELECT (id,turnkey_address,status,owner_wallet) ON ' + namespace + '.agents TO bard_vcr');
    await db.query('GRANT SELECT ON ' + namespace + '.vcr_reservations TO bard_vcr');
    await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + namespace + '.vcr_policies,' + namespace + '.vcr_service_nonces TO bard_vcr');
    await db.query('GRANT SELECT,INSERT ON ' + namespace + '.vcr_policy_events TO bard_vcr');
    await db.query('GRANT USAGE,SELECT ON SEQUENCE ' + namespace + '.vcr_policy_events_id_seq TO bard_vcr');
    await db.query('COMMIT');
  } catch {
    await db.query('ROLLBACK').catch(() => {});
    throw new Error('Could not provision the restricted VCR database role.');
  } finally { db.release(); }
}

import 'dotenv/config';
import { pool } from './db.js';

const PLATFORM_SWARMS = [
  {
    id: 'swarm-platform-code-review',
    agent_name: 'Code Review Swarm',
    agent_type: 'swarm',
    is_platform_owned: 1,
    description: 'Multi-agent code review: linter checks style and formatting, security scanner identifies vulnerabilities, and reviewer provides architectural feedback.',
    swarm_config: JSON.stringify({
      swarm_type: 'SequentialWorkflow',
      agents: [
        {
          role: 'linter',
          system_prompt: 'You are a code style and formatting expert. Check code for style violations, formatting issues, and adherence to best practices. Provide specific line-by-line feedback.',
          model: 'gpt-4o'
        },
        {
          role: 'security',
          system_prompt: 'You are a security expert. Scan code for vulnerabilities including SQL injection, XSS, CSRF, insecure dependencies, and OWASP Top 10 issues. Flag security risks with severity levels.',
          model: 'gpt-4o'
        },
        {
          role: 'reviewer',
          system_prompt: 'You are a senior software architect. Review code for architectural soundness, maintainability, scalability, and design patterns. Provide high-level feedback and improvement suggestions.',
          model: 'gpt-4o'
        }
      ]
    }),
    owner_wallet: process.env.PLATFORM_OWNER_WALLET || '0xPLATFORM',
    agent_public_key: '0xPLATFORM_CODE_REVIEW',
    reputation_score: 100,
    hourly_rate_usdc: 5,
    specializations: JSON.stringify(['code_review', 'security', 'architecture']),
    availability: 'available'
  },
  {
    id: 'swarm-platform-research',
    agent_name: 'Research Swarm',
    agent_type: 'swarm',
    is_platform_owned: 1,
    description: 'Multi-agent research team: data gatherer collects sources, analyst synthesizes findings, and fact-checker verifies claims.',
    swarm_config: JSON.stringify({
      swarm_type: 'SequentialWorkflow',
      agents: [
        {
          role: 'gatherer',
          system_prompt: 'You are a research data gatherer. Find and collect relevant sources, papers, articles, and documentation for the given research topic. Provide URLs and brief summaries.',
          model: 'gpt-4o'
        },
        {
          role: 'analyst',
          system_prompt: 'You are a research analyst. Synthesize the gathered sources into a coherent analysis. Identify patterns, key findings, and insights. Structure your output clearly.',
          model: 'gpt-4o'
        },
        {
          role: 'fact_checker',
          system_prompt: 'You are a fact-checker. Verify claims made in the analysis against the original sources. Flag any unsupported claims or inconsistencies. Provide a confidence score.',
          model: 'gpt-4o'
        }
      ]
    }),
    owner_wallet: process.env.PLATFORM_OWNER_WALLET || '0xPLATFORM',
    agent_public_key: '0xPLATFORM_RESEARCH',
    reputation_score: 100,
    hourly_rate_usdc: 4,
    specializations: JSON.stringify(['research', 'data_analysis', 'verification']),
    availability: 'available'
  },
  {
    id: 'swarm-platform-doc-gen',
    agent_name: 'Documentation Generator Swarm',
    agent_type: 'swarm',
    is_platform_owned: 1,
    description: 'Multi-agent documentation team: code analyzer extracts structure, writer generates docs, and editor polishes the output.',
    swarm_config: JSON.stringify({
      swarm_type: 'SequentialWorkflow',
      agents: [
        {
          role: 'analyzer',
          system_prompt: 'You are a code analyzer. Extract the structure, functions, classes, APIs, and dependencies from the provided code. Create a structured outline for documentation.',
          model: 'gpt-4o'
        },
        {
          role: 'writer',
          system_prompt: 'You are a technical writer. Generate comprehensive documentation from the code analysis. Include usage examples, parameter descriptions, return values, and edge cases.',
          model: 'gpt-4o'
        },
        {
          role: 'editor',
          system_prompt: 'You are a documentation editor. Polish the generated docs for clarity, consistency, and completeness. Fix grammar, improve examples, and ensure proper formatting.',
          model: 'gpt-4o'
        }
      ]
    }),
    owner_wallet: process.env.PLATFORM_OWNER_WALLET || '0xPLATFORM',
    agent_public_key: '0xPLATFORM_DOC_GEN',
    reputation_score: 100,
    hourly_rate_usdc: 3,
    specializations: JSON.stringify(['content', 'code_review', 'documentation']),
    availability: 'available'
  }
];

async function seedPlatformSwarms() {
  console.log('\n🌱 Seeding platform swarms...\n');

  try {
    for (const swarm of PLATFORM_SWARMS) {
      // Check if swarm already exists
      const existing = await pool.query('SELECT id FROM agents WHERE id = $1', [swarm.id]);

      if (existing.rows.length > 0) {
        console.log(`⏭️  Skipping ${swarm.agent_name} (already exists)`);
        continue;
      }

      // Insert swarm agent
      await pool.query(
        `INSERT INTO agents (
          id, owner_wallet, agent_name, agent_public_key, agent_type, description,
          reputation_score, hourly_rate_usdc, specializations, availability,
          swarm_config, is_platform_owned, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          swarm.id,
          swarm.owner_wallet,
          swarm.agent_name,
          swarm.agent_public_key,
          swarm.agent_type,
          swarm.description,
          swarm.reputation_score,
          swarm.hourly_rate_usdc,
          swarm.specializations,
          swarm.availability,
          swarm.swarm_config,
          swarm.is_platform_owned,
          new Date().toISOString()
        ]
      );

      // Initialize agent state
      await pool.query(
        `INSERT INTO agent_state (agent_id, context, last_activity, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id) DO NOTHING`,
        [swarm.id, '{}', new Date().toISOString(), new Date().toISOString()]
      );

      console.log(`✅ Created ${swarm.agent_name} (${swarm.id})`);
    }

    console.log('\n✨ Platform swarms seeded successfully!\n');
    console.log('Swarm IDs:');
    PLATFORM_SWARMS.forEach(s => console.log(`  - ${s.id}: ${s.agent_name}`));
    console.log('');

  } catch (error) {
    console.error('❌ Error seeding platform swarms:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seedPlatformSwarms();

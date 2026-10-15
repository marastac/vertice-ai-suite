#!/usr/bin/env node
// Automated CONCURRENCY tests for the database RPCs whose correctness depends
// on locking — things a single ROLLBACK-only SQL script can't exercise:
//   C1–C6  monthly chat quotas (supabase/migrations-usage-quotas.sql): they
//          automate the manual two-connection procedures at the end of
//          supabase/tests-usage-quotas.sql.
//   O1     first-login organization provisioning
//          (supabase/migrations-org-bootstrap.sql): the same user calling
//          bootstrap_personal_organization() from several tabs at once must
//          end up with exactly ONE organization.
//   L1     chat lead upsert (supabase/migrations-chat-lead-isolation.sql):
//          simultaneous updates of the same conversation's lead, mixed with
//          calls naming another organization, end with ONE intact lead.
//
// DISPOSABLE POSTGRES ONLY. Concurrency needs COMMITTED data, so this script
// writes (and afterwards deletes) its own test organizations. To make it
// impossible to point at a real database it only talks to a local Docker
// container through `docker exec`, and refuses to run unless that container
// has NO network at all (`--network none`): such a container can't be a
// staging or production database. Nothing here calls Anthropic or Supabase.
//
// Usage (the container must already have supabase/schema.sql applied):
//   docker run -d --name maastac-audit-pg --network none \
//     -e POSTGRES_PASSWORD=<any> public.ecr.aws/supabase/postgres:<tag>
//   (apply supabase/schema.sql — see tests-usage-quotas.sql's header)
//   QUOTA_TEST_CONTAINER=maastac-audit-pg npm run test:db:concurrency
//
// Exit codes: 0 all passed · 1 a check failed · 2 refused to run.

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const container = process.env.QUOTA_TEST_CONTAINER?.trim()

function refuse(message) {
  console.error(`✖ No se ejecuta: ${message}`)
  process.exit(2)
}

if (!container) refuse('define QUOTA_TEST_CONTAINER con el nombre de un contenedor Docker de Postgres DESECHABLE.')
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) refuse('QUOTA_TEST_CONTAINER no es un nombre de contenedor válido.')

const inspect = spawnSync('docker', ['inspect', '-f', '{{.HostConfig.NetworkMode}}|{{.State.Running}}', container], { encoding: 'utf8' })
if (inspect.status !== 0) refuse(`no existe el contenedor "${container}" (o Docker no está disponible).`)
const [networkMode, running] = inspect.stdout.trim().split('|')
if (networkMode !== 'none') {
  refuse(`el contenedor "${container}" tiene red (${networkMode}). Solo se acepta un Postgres aislado con --network none.`)
}
if (running !== 'true') refuse(`el contenedor "${container}" no está en ejecución.`)

// ── psql helpers ─────────────────────────────────────────────────────────────

/** Runs SQL as `postgres` inside the container. Resolves { ok, out, err, ms }. */
function psql(sql) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1'])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), ms: Date.now() - started }))
    child.stdin.end(sql)
  })
}

async function sql(text) {
  const r = await psql(text)
  if (!r.ok) throw new Error(`SQL falló: ${r.err}`)
  return r.out
}

const lastJson = (out) => JSON.parse(out.split('\n').filter(Boolean).pop())

/** Runs `bodies` in parallel, each starting at the same database-clock instant. */
async function simultaneously(bodies) {
  const start = await sql(`select (clock_timestamp() + interval '8 seconds')::text`)
  const barrier = `select pg_sleep(greatest(0, extract(epoch from ('${start}'::timestamptz - clock_timestamp()))));`
  return Promise.all(bodies.map((body) => psql(`${barrier}\n${body}`)))
}

// ── checks ───────────────────────────────────────────────────────────────────

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
}

const run = randomUUID().slice(0, 8)
const MODEL = `test-model-concurrency-${run}`
const org = {
  budget: randomUUID(),
  conversations: randomUUID(),
  replay: randomUUID(),
  other: randomUUID(),
}
const bootstrapUser = randomUUID()
const reserve = (organizationId, requestId = randomUUID(), sessionId = randomUUID()) =>
  `select public.reserve_chat_usage('${requestId}', '${organizationId}', '${sessionId}', '${MODEL}', 10, 10)::text;`
// Fictitious prices (1 and 2 micro-USD per token) → one reservation = 10·1 + 10·2 = 30 micro-USD.
const RESERVATION_MICROS = 30

async function setup() {
  await sql(`
    begin;
    insert into public.organizations (id, name, slug) values
      ('${org.budget}', 'Concurrency budget ${run}', 'qc-budget-${run}'),
      ('${org.conversations}', 'Concurrency conversations ${run}', 'qc-conv-${run}'),
      ('${org.replay}', 'Concurrency replay ${run}', 'qc-replay-${run}'),
      ('${org.other}', 'Concurrency other ${run}', 'qc-other-${run}');
    -- the trigger created 'shadow' rows; switch them to explicit enforce limits
    update public.organization_quotas set enforcement_mode = 'enforce', conversation_limit_override = 1000, budget_micros_override = ${5 * RESERVATION_MICROS}
      where organization_id = '${org.budget}';
    update public.organization_quotas set enforcement_mode = 'enforce', conversation_limit_override = 3, budget_micros_override = 1000000000
      where organization_id = '${org.conversations}';
    update public.organization_quotas set enforcement_mode = 'enforce', conversation_limit_override = 1000, budget_micros_override = 1000000000
      where organization_id in ('${org.replay}', '${org.other}');
    insert into public.model_prices (model, input_micros_per_mtok, output_micros_per_mtok, source_url, verified_on)
      values ('${MODEL}', 1000000, 2000000, 'https://platform.claude.com/docs/en/about-claude/pricing', current_date);
    commit;`)
}

async function cleanup() {
  await psql(`
    delete from public.organizations where created_by = '${bootstrapUser}';
    delete from auth.users where id = '${bootstrapUser}';`)
  await psql(`
    delete from public.organizations where id in ('${org.budget}', '${org.conversations}', '${org.replay}', '${org.other}');
    delete from public.model_prices where model = '${MODEL}';`)
}

const period = (organizationId) =>
  sql(`select coalesce(sum(reserved_micros), 0) || '|' || coalesce(sum(settled_micros), 0) || '|' || coalesce(sum(conversations_used), 0)
       from public.usage_periods where organization_id = '${organizationId}'`).then((s) => s.split('|').map(Number))

async function main() {
  await setup()

  // Under heavy contention or CPU load a waiter can exceed the RPCs'
  // lock_timeout (2 s) — the DESIGNED fail-closed outcome: the call errors with
  // 55P03, records nothing, and quota-service retries it once with the same id.
  // So "lock timeout" is accepted below; ANY other error still fails, and the
  // money invariants are checked whatever the timing.
  // Reservations actually allowed in C1/C2 — what C6 later expects to expire.
  let c1Allowed = 0
  let c2Allowed = 0
  const toAnswer = (r) => (r.ok ? lastJson(r.out) : { error: r.err.split('\n')[0] })
  const isLockTimeout = (a) => Boolean(a.error) && /lock timeout/i.test(a.error)
  const otherErrors = (answers) => answers.filter((a) => a.error && !isLockTimeout(a)).map((a) => a.error)

  // C1 — budget race: room for exactly 5 reservations, 20 arrive at once.
  {
    const answers = (await simultaneously(Array.from({ length: 20 }, () => reserve(org.budget)))).map(toAnswer)
    const allowed = (c1Allowed = answers.filter((a) => a.allowed).length)
    const timeouts = answers.filter(isLockTimeout).length
    const [reserved] = await period(org.budget)
    check(
      'C1 carrera de presupuesto: 20 simultáneas, cabe exactamente 5',
      timeouts === 0 ? allowed === 5 : allowed <= 5 && allowed + timeouts >= 5,
      `permitidas=${allowed}, lock_timeout=${timeouts}`,
    )
    check(
      'C1 las demás son budget_exhausted o lock_timeout (ningún otro error)',
      otherErrors(answers).length === 0 && answers.filter((a) => a.allowed === false).every((a) => a.reason === 'budget_exhausted'),
      otherErrors(answers)[0] ?? `rechazadas=${answers.filter((a) => a.allowed === false).length}`,
    )
    check(
      'C1 el reservado nunca supera el presupuesto y cuadra con lo permitido',
      reserved <= 5 * RESERVATION_MICROS && reserved === allowed * RESERVATION_MICROS,
      `reserved_micros=${reserved} (presupuesto ${5 * RESERVATION_MICROS})`,
    )
  }

  // C2 — conversation-limit race: limit 3, 12 new conversations at once.
  {
    const answers = (await simultaneously(Array.from({ length: 12 }, () => reserve(org.conversations)))).map(toAnswer)
    const allowed = (c2Allowed = answers.filter((a) => a.allowed).length)
    const timeouts = answers.filter(isLockTimeout).length
    const [, , conversations] = await period(org.conversations)
    check(
      'C2 carrera de conversaciones: límite 3, 12 simultáneas → 3 permitidas',
      timeouts === 0 ? allowed === 3 : allowed <= 3 && allowed + timeouts >= 3,
      `permitidas=${allowed}, lock_timeout=${timeouts}`,
    )
    check('C2 conversations_used nunca supera el límite y cuadra', conversations <= 3 && conversations === allowed, `conversations_used=${conversations}`)
    check(
      'C2 las demás son conversation_limit_reached o lock_timeout',
      otherErrors(answers).length === 0 && answers.filter((a) => a.allowed === false).every((a) => a.reason === 'conversation_limit_reached'),
      otherErrors(answers)[0] ?? '',
    )
  }

  // C3 — idempotency under concurrency: the SAME request id 8 times at once.
  let replayReservationId = null
  {
    const requestId = randomUUID()
    const sessionId = randomUUID()
    const answers = (await simultaneously(Array.from({ length: 8 }, () => reserve(org.replay, requestId, sessionId)))).map(toAnswer)
    const answered = answers.filter((a) => !a.error)
    const ids = new Set(answered.map((a) => a.reservation_id))
    const rows = Number(await sql(`select count(*) from public.usage_reservations where request_id = '${requestId}'`))
    const [reserved, , conversations] = await period(org.replay)
    replayReservationId = [...ids][0]
    check('C3 mismo request_id ×8 simultáneo: una sola fila de reserva', rows === 1, `filas=${rows}`)
    check(
      'C3 todas las respondidas permitidas, con el mismo reservation_id (sin otros errores)',
      answered.length > 0 && answered.every((a) => a.allowed) && ids.size === 1 && otherErrors(answers).length === 0,
      otherErrors(answers)[0] ?? `ids distintos=${ids.size}, lock_timeout=${answers.filter(isLockTimeout).length}`,
    )
    check(
      'C3 solo una respuesta crea la reserva; las demás son replay',
      answered.filter((a) => !a.replayed).length === 1,
      `nuevas=${answered.filter((a) => !a.replayed).length}`,
    )
    check('C3 se cobra una sola vez (reservado y conversaciones)', reserved === RESERVATION_MICROS && conversations === 1, `reserved=${reserved}, conversaciones=${conversations}`)
  }

  // C4 — the same reservation settled 8 times at once: applied exactly once.
  {
    const answers = (
      await simultaneously(Array.from({ length: 8 }, () => `select public.settle_chat_usage('${replayReservationId}', 5, 5, '${MODEL}')::text;`))
    ).map(toAnswer)
    const answered = answers.filter((a) => !a.error)
    const [reserved, settled] = await period(org.replay)
    check('C4 liquidación ×8 simultánea: sin errores salvo lock_timeout', otherErrors(answers).length === 0, otherErrors(answers)[0] ?? '')
    check('C4 aplicada una sola vez (el resto, replay)', answered.filter((a) => !a.replayed).length === 1, `aplicadas=${answered.filter((a) => !a.replayed).length}`)
    check('C4 importes finales: reservado 0, liquidado 5·1+5·2=15', reserved === 0 && settled === 15, `reserved=${reserved}, settled=${settled}`)
  }

  // Holds the row lock of an organization's quota until released — independent
  // of how slow `docker exec` is on this machine: the holder is only
  // considered active once Postgres itself shows it sleeping.
  async function holdQuotaLock(organizationId) {
    const tag = `qc_hold_${randomUUID().slice(0, 8)}`
    const done = psql(`begin; select 1 from public.organization_quotas where organization_id = '${organizationId}' for update; select pg_sleep(60) as ${tag}; commit;`)
    for (let i = 0; i < 120; i++) {
      const pid = await sql(`select coalesce(max(pid)::text, '') from pg_stat_activity where state = 'active' and query like '%as ${tag}%' and query not like '%pg_stat_activity%'`)
      if (pid) {
        return async () => {
          await sql(`select pg_terminate_backend(${pid})`)
          await done
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('el bloqueador no llegó a activarse')
  }
  // Database-side duration of one call, so docker exec latency never counts.
  const timed = (call) => `select json_build_object('ms', extract(epoch from x.t1 - x.t0) * 1000, 'r', x.r)::text from (select clock_timestamp() as t0, (${call}) as r, clock_timestamp() as t1) x;`

  // C5 — row lock: another organization never waits; the same one times out cleanly.
  {
    const release = await holdQuotaLock(org.budget)
    const other = await psql(timed(`public.reserve_chat_usage('${randomUUID()}', '${org.other}', '${randomUUID()}', '${MODEL}', 10, 10)`))
    const lockedRequest = randomUUID()
    const same = await psql(timed(`public.reserve_chat_usage('${lockedRequest}', '${org.budget}', '${randomUUID()}', '${MODEL}', 10, 10)`))
    const leftover = Number(await sql(`select count(*) from public.usage_reservations where request_id = '${lockedRequest}'`))
    await release()
    const otherJson = other.ok ? lastJson(other.out) : {}
    check('C5 otra organización no espera al bloqueo', other.ok && otherJson.r?.allowed && otherJson.ms < 1000, other.ok ? `${Math.round(otherJson.ms)} ms en la base de datos` : other.err.split('\n')[0])
    check('C5 la organización bloqueada falla por lock_timeout (55P03)', !same.ok && /lock timeout/i.test(same.err), same.ok ? 'respondió sin error' : same.err.split('\n')[0])
    check('C5 el intento bloqueado no deja ninguna reserva', leftover === 0, `filas=${leftover}`)
  }

  // C6 — reconciliation skips a busy organization (SKIP LOCKED) and never waits.
  {
    await sql(`update public.usage_reservations set created_at = created_at - interval '20 minutes' where status = 'reserved' and organization_id in ('${org.budget}', '${org.conversations}')`)
    const release = await holdQuotaLock(org.budget)
    const first = await psql(timed('public.expire_stale_chat_reservations()'))
    const firstJson = first.ok ? lastJson(first.out) : {}
    const budgetStillReserved = Number(await sql(`select count(*) from public.usage_reservations where organization_id = '${org.budget}' and status = 'reserved'`))
    const conversationsExpired = Number(
      await sql(`select count(*) from public.usage_reservations where organization_id = '${org.conversations}' and settlement_basis = 'expired'`),
    )
    await release()
    const second = await psql(`select public.expire_stale_chat_reservations()::text;`)
    const [reservedAfter, settledAfter] = await period(org.budget)
    check('C6 la conciliación no espera a la organización ocupada', first.ok && firstJson.ms < 1000, first.ok ? `${Math.round(firstJson.ms)} ms en la base de datos` : first.err.split('\n')[0])
    check(
      'C6 la salta (skipped_locked ≥ 1) y no toca sus reservas',
      firstJson.r?.organizations_skipped_locked >= 1 && budgetStillReserved === c1Allowed,
      `skipped=${firstJson.r?.organizations_skipped_locked}, siguen reservadas=${budgetStillReserved}`,
    )
    check('C6 expira las de la otra organización', conversationsExpired === c2Allowed, `expiradas=${conversationsExpired}`)
    check(
      'C6 al liberarse, expira las restantes a su estimación completa (nunca gratis)',
      second.ok && reservedAfter === 0 && settledAfter === c1Allowed * RESERVATION_MICROS,
      `reserved=${reservedAfter}, settled=${settledAfter}`,
    )
  }
}

// O1 — the same user provisioning from 10 tabs at once → exactly one organization.
async function organizationBootstrap() {
  const email = `qc-${run}@example.test`
  await sql(`insert into auth.users (id, email) values ('${bootstrapUser}', '${email}')`)
  const claims = JSON.stringify({ sub: bootstrapUser, email, role: 'authenticated', user_metadata: { full_name: `QC ${run}` } })
  const call = `select set_config('request.jwt.claim.sub', '${bootstrapUser}', false);
    select set_config('request.jwt.claims', '${claims}', false);
    set role authenticated;
    select json_build_object('organization_id', organization_id, 'created', created)::text from public.bootstrap_personal_organization();`
  const answers = (await simultaneously(Array.from({ length: 10 }, () => call))).map((r) => (r.ok ? lastJson(r.out) : { error: r.err }))
  const counts = (
    await sql(`select (select count(*) from public.organizations where created_by = '${bootstrapUser}') || '|' ||
                       (select count(*) from public.organization_members where user_id = '${bootstrapUser}') || '|' ||
                       (select count(*) from public.team_members where email = '${email}')`)
  ).split('|').map(Number)
  const firstError = answers.find((a) => a.error)?.error?.split('\n')[0] ?? ''
  const createdCount = answers.filter((a) => a.created).length
  const distinctIds = new Set(answers.map((a) => a.organization_id)).size
  check('O1 10 llamadas simultáneas del mismo usuario: sin errores', answers.every((a) => !a.error), firstError)
  check(
    'O1 exactamente UNA organización, una membresía y un team_member',
    counts.join(',') === '1,1,1',
    `organizaciones=${counts[0]}, membresías=${counts[1]}, team_members=${counts[2]}`,
  )
  check('O1 solo una llamada la crea; las demás devuelven la misma', createdCount === 1 && distinctIds === 1, `created=${createdCount}, ids=${distinctIds}`)
}

// L1 — 10 legitimate upserts of the same chat lead at once, plus 5 calls naming
// another organization with that same session: one lead, never moved or
// overwritten across organizations.
async function chatLeadUpsert() {
  const sessionId = randomUUID()
  await sql(`insert into public.chat_configuration (organization_id, assistant_name, welcome_message, tone, is_active)
             values ('${org.other}', 'Asistente QC', 'Hola', 'friendly', true)`)
  await sql(`select public.create_public_chat_session('${sessionId}', '${org.other}', 'qc-other-${run}')`)
  const upsert = (organizationId, name, score) => `set role anon;
    select (public.upsert_chat_lead('${organizationId}', '${sessionId}', '${name}', 'lead-${run}@example.test', '', '', 'qualifying', ${score}, null)).id::text;`
  const results = await simultaneously([
    ...Array.from({ length: 10 }, (_, i) => upsert(org.other, `Legítimo ${i}`, 50 + i)),
    ...Array.from({ length: 5 }, () => upsert(org.budget, 'Ajeno', 0)),
  ])
  const legit = results.slice(0, 10)
  const foreign = results.slice(10)
  const [leads, wrongOrg, foreignNames, activities] = (
    await sql(`select (select count(*) from public.leads where chat_session_id = '${sessionId}') || '|' ||
                       (select count(*) from public.leads where chat_session_id = '${sessionId}' and organization_id <> '${org.other}') || '|' ||
                       (select count(*) from public.leads where chat_session_id = '${sessionId}' and name = 'Ajeno') || '|' ||
                       (select count(*) from public.lead_activity a join public.leads l on l.id = a.lead_id where l.chat_session_id = '${sessionId}')`)
  ).split('|').map(Number)
  const firstLegitError = legit.find((r) => !r.ok)?.err.split('\n')[0] ?? ''
  check('L1 10 actualizaciones legítimas simultáneas: sin errores', legit.every((r) => r.ok), firstLegitError)
  check('L1 las 5 llamadas con otra organización se rechazan', foreign.every((r) => !r.ok && /CHAT_SESSION_NOT_FOUND/.test(r.err)), `rechazadas=${foreign.filter((r) => !r.ok).length}`)
  check('L1 un solo lead, en su organización y nunca sobrescrito por las ajenas', leads === 1 && wrongOrg === 0 && foreignNames === 0, `leads=${leads}, otra org=${wrongOrg}, sobrescritos=${foreignNames}`)
  check('L1 una actividad por llamada legítima (y ninguna de las rechazadas)', activities === 10, `actividades=${activities}`)
}

try {
  await main()
  await organizationBootstrap()
  await chatLeadUpsert()
} catch (error) {
  results.push({ name: 'ejecución', ok: false, detail: error instanceof Error ? error.message : String(error) })
} finally {
  await cleanup()
}

const leftovers = Number((await psql(`select count(*) from public.organizations where slug like 'qc-%-${run}'`)).out || '0')
check('limpieza: no quedan organizaciones de prueba', leftovers === 0, `quedan=${leftovers}`)

console.log(`\n══════════ concurrencia: cuotas + aprovisionamiento + leads de chat (contenedor ${container}, sin red) ══════════`)
for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\nRESULTADO: ${results.length - failed} OK, ${failed} fallos`)
process.exit(failed === 0 ? 0 : 1)

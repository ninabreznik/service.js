const DB = require('../../src/DB')
const makeSets = require('../../src/node_modules/makeSets')
const blockgenerator = require('../../src/node_modules/scheduleAction')
const datdot_crypto = require('../../src/node_modules/datdot-crypto')
const logkeeper = require('../scenarios/logkeeper')
const varint = require('varint')
const WebSocket = require('ws')
const storage_report_codec = require('../../src/node_modules/datdot-codec/storage-report')
const PriorityQueue = require('../../src/node_modules/priority-queue')
const priority_queue = PriorityQueue(compare)
const connections = {}
const handlers = []
const scheduler = init()
var header = { number: 0 }

function compare (item) {
  return item
}

async function init () {
  const [json, logport] = process.argv.slice(2)
  const config = JSON.parse(json)
  const [host, PORT] = config.chain
  const name = `chain`
  const [log, getLogger] = await logkeeper(name, logport)
  const wss = new WebSocket.Server({ port: PORT }, after)
  function after () {
    log({ type: 'chain', data: [`running on http://localhost:${wss.address().port}`] })
  }
  wss.on('connection', function connection (ws) {
    ws.on('message', async function incoming (message) {
      var { flow, type, data } = JSON.parse(message)
      const [from, id] = flow

      if (id === 0 && type === 'newUser') { // a new connection
        const { args, nonce, address } = data
        // 1. do we have that user in the database already?
        if  (from && address && !connections[from] && !DB.lookups.userByAddress[address]) {
          connections[from] = { name: from, counter: id, ws, log: log.sub(from) }
          handlers.push([from, data => ws.send(JSON.stringify({ data }))])
          // @TODO: ...
          if (!messageVerifiable(message)) return
          _newUser(args, from, address, log)
          // 2. is the message verifiable, pubkeys, noisekeys, signatures?
          // 3. => add user and address and user data to database
        }
        else return ws.send(JSON.stringify({
          cite: [flow], type: 'error', data: 'name is already taken'
        }))
        // return
      }
      if (type === 'submitStorageChallenge') data = storage_report_codec.decode(data)
      // console.log({message})

      const _log = connections[from].log
      _log({ type: 'chain', data: [`${JSON.stringify(type)} ${JSON.stringify(flow)}`] })
      const method = queries[type] || signAndSend
      if (!method) return ws.send({ cite: [flow], type: 'error', data: 'unknown type' })
      const result = await method(data, from, data => {
        // _log({ type: 'chain', data: [`send data after "${type}" to: ${from}`] })
        ws.send(JSON.stringify({ cite: [flow], type: 'data', data }))
      })
      if (!result) return
      const msg = { cite: [flow], type: 'done', data: result }
      // _log({ type: 'chain', data: [`sending "${type}" to: ${from}`] })
      ws.send(JSON.stringify(msg))
    })
  })
  return blockgenerator({ actions, getLogger }, log.sub('blockgenerator'), blockMessage => {
    header = blockMessage.data
    Object.entries(connections).forEach(([name, channel]) => {
      channel.ws.send(JSON.stringify(blockMessage))
    })
  })
}

function messageVerifiable (message) {
  return true
}
/******************************************************************************
  QUERIES
******************************************************************************/
const queries = {
  getItemByID,
  getFeedByID,
  getFeedByKey,
  getUserByID,
  getUserIDByNoiseKey,
  getUserIDBySigningKey,
  getPlanByID,
  getAmendmentByID,
  getContractByID,
  getStorageChallengeByID,
  getPerformanceChallengeByID,
}

// function getFeedByID (id) { return DB.feeds[id] }
// function getUserByID (id) { return DB.users[id] }
// function getPlanByID (id) { return DB.plans[id] }
// function getContractByID (id) { return DB.contracts[id] }
// function getAmendmentByID (id) { return DB.amendments[id] }
// function getStorageChallengeByID (id) { return DB.storageChallenges[id] }
// function getPerformanceChallengeByID (id) { return DB.performanceChallenges[id] }
function getItemByID (id) { return getItem(id) }
function getDatasetByID (id) { return getItem(id) }
function getFeedByID (id) { return getItem(id) }
function getUserByID (id) { return getItem(id) }
function getPlanByID (id) { return getItem(id) }
function getContractByID (id) { return getItem(id) }
function getAmendmentByID (id) { return getItem(id) }
function getStorageChallengeByID (id) { return getItem(id) }
function getPerformanceChallengeByID (id) { return getItem(id) }
// ---
function getFeedByKey (key) {
  const keyBuf = Buffer.from(key, 'hex')
  return DB.lookups.feedByKey[keyBuf.toString('hex')]
}
function getUserIDByNoiseKey(key) {
  const keyBuf = Buffer.from(key, 'hex')
  return DB.lookups.userIDByNoiseKey[keyBuf.toString('hex')]
}
function getUserIDBySigningKey(key) {
  const keyBuf = Buffer.from(key, 'hex')
  return DB.lookups.userIDBySigningKey[keyBuf.toString('hex')]
}
/******************************************************************************
  ROUTING (sign & send)
******************************************************************************/
async function signAndSend (data, name, status) {
  const log = connections[name].log
  const { type, args, nonce, address } = data
  
  status({ events: [], status: { isInBlock:1 } })
  
  const user = await _getUser(address, { name, nonce }, status)
  if (!user) return log({ type: 'chain', data: [`UNKNOWN SENDER of: ${data}`] }) // TODO: maybe use status() ??

  else if (type === 'publishPlan') _publish_plan(user, { name, nonce }, status, args)
  else if (type === 'registerForWork') _register_for_work(user, { name, nonce }, status, args)
  else if (type === 'amendmentReport') _amendment_report(user, { name, nonce }, status, args)
  else if (type === 'submitStorageChallenge') _storage_challenge_report(user, { name, nonce }, status, args)
  else if (type === 'submitPerformanceChallenge') _submitPerformanceChallenge(user, { name, nonce }, status, args)
  // else if ...
}
/******************************************************************************
  SCHEDULABLE ACTIONS
******************************************************************************/
const actions = { plan_execution, amendment_followup, storage_challenge_followup, execute_storage_challenge }

async function plan_execution (log, data) {
  const {contract_id} = data
  const reuse = { encoders: [], attestors: [], hosters: [] }
  const amendment_id = await init_amendment(contract_id, reuse, log)
  add_to_pending(amendment_id)
  try_next_amendment(log)
}

async function execute_storage_challenge (log, data) {
  const {user} = data
  if (!user.hoster.challenges.storage) return
  make_storage_challenge({ hoster_id: user.id, log })
  // then every interval start the challenge again
  const { scheduleAction } = await scheduler
  scheduleAction({ from: log.path, data: { user}, delay: 3, type: 'execute_storage_challenge' })
}

async function storage_challenge_followup (log, data) {}

async function amendment_followup (log, data) {
  console.log('This is a scheduled amendment follow up for amendment ', id)
  // TODO get all necessary data to call this exstrinsic from the chain
  // const { providers: { attestors } } = getAmendmentByID(id)
  // const report = [id, attestors]
  // const [attestorID] = attestors
  // const user = getUserByID(attestorID)
  // amendmentReport(user, { name, nonce }, status, [report])

  // console.log('scheduleAmendmentFollowUp', sid)
  // const contract = getContractByID(contractID)
  // // if (contract.activeHosters.length >= 3) return
  //
  // removeJobForRolesXXXX({ failedHosters: [], amendment, doneJob: `NewAmendment${id}` }, log)
  // // TODO update reuse
  // // const reuse = { attestors: [], encoders, hosters }
  // const reuse = { attestors: [], encoders: [], hosters: [] }
  // const newID = init_amendment(contractID, reuse, log)
  // add_to_pending(newID)
  // return id
}
/******************************************************************************
  API
******************************************************************************/
async function _getUser (address, { name, nonce }, status) {
  const log = connections[name].log
  const pos = DB.lookups.userByAddress[address]
  const user = getUserByID(pos)
  log({ type: 'chain', data: [`Existing user: ${name}, ${user.id}, ${address}`] })
  return user
}

/*----------------------
      STORE ITEM
------------------------*/
function addItem (item) {
  if ('id' in item) throw new Error('new items cannot have "id" property')
  const id = DB.storage.length
  item.id = id
  DB.storage.push([item])
  return id
}
function getItem (id) {
  if (!Number.isInteger(id)) return
  if (id < 0) return
  const len = DB.storage.length
  if (id >= len) return
  const history = DB.storage[id]
  if (!Array.isArray(history)) return
  const next = history.length
  const item = history[next - 1]
  return item
}
function delItem (id) {
  if (!Number.isInteger(id)) return
  if (id < 0) return
  const len = DB.storage.length
  if (id >= len) return
  const history = DB.storage[id]
  if (!Array.isArray(history)) return
  return !!history.push(void 0)
}
function updateItem (id, item) {
  if (!Number.isInteger(id)) return
  if (id < 0) return
  const len = DB.storage.length
  if (id >= len) return
  const history = DB.storage[id]
  if (!Array.isArray(history)) return
  return !!history.push(item)
}

/*----------------------
      NEW USER
------------------------*/
async function _newUser (args, name, address, log) {
  let [data] = args
  const { signingPublicKey, noiseKey } = data

  const user = { address }
  addItem(user)
  DB.lookups.userByAddress[address] = user.id
  log({ type: 'chain', data: [`New user: ${name}, ${JSON.stringify(user)}`] })

  user.signingKey = signingPublicKey
  const signingKeyBuf = Buffer.from(signingPublicKey, 'hex')
  DB.lookups.userIDBySigningKey[signingKeyBuf.toString('hex')] = user.id

  user.noiseKey = noiseKey
  const noiseBuf = Buffer.from(noiseKey, 'hex')
  DB.lookups.userIDByNoiseKey[noiseBuf.toString('hex')] = user.id
}

/*----------------------
      REGISTER FOR WORK
------------------------*/
async function _register_for_work (user, { name, nonce }, status, args) {
  const log = connections[name].log
  let [form] = args
  const { components } = form
  const { resources_ids, performances_ids, timetables_ids, regions_ids } = await publish_form_components(components)

  form.timetables = form.timetables.map(ref => { if (ref < 0) return timetables_ids[(Math.abs(ref) - 1)] })
  form.regions = form.regions.map(ref => { if (ref < 0) return regions_ids[(Math.abs(ref) - 1)] })
  form.performances = form.performances.map(ref => { if (ref < 0) return performances_ids[(Math.abs(ref) - 1)] })
  form.resources = form.resources.map(ref => { if (ref < 0) return resources_ids[(Math.abs(ref) - 1)] })
  user.form = form
  user.idleStorage = getItem(form.resources[0]).storage

  ;['encoder', 'hoster', 'attestor'].forEach(role => registerRole (user, role, log))
}

/*----------------------
      PUBLISH FEED
------------------------*/
// TODO:
// * we wont start hosting a plan before the check
// * 3 attestors
// * provide signature for highest index in ranges
// * provide all root hash sizes required for ranges
// => native api feed.getRoothashes() provides the values

/*----------------------
      (UN)PUBLISH PLAN
------------------------*/
async function _publish_plan (user, { name, nonce }, status, args) {
  const log = connections[name].log
  log({ type: 'chain', data: [`Publishing a plan`] })
  let [data] = args
  const { plan, components, proofs = {}  } = data
  const { program } = plan
  const feed_ids = await Promise.all(components.feeds.map(async feed => await publish_feed(feed, user.id, log)))
  store_root_signatures(proofs, feed_ids)
  const component_ids = await publish_plan_components(log, components, feed_ids)

  const updated_program = []
  for (var i = 0, len = program.length; i < len; i++) {
    const item = program[i]
    if (item.plans) updated_program.push(...getPrograms(item.plan))
    else updated_program.push(handleNew(item, component_ids))
  }
  plan.program = updated_program
  if (!planValid({ plan })) return log({ type: 'chain', data: [`Plan from and/or until are invalid`] })
  plan.sponsor = user.id

  plan.contracts = []
  const id = addItem(plan)

  priority_queue.add({ type: 'plan', id })
  take_next_from_priority(priority_queue.take(), log) // schedule the plan execution
}

async function unpublishPlan (user, { name, nonce }, status, args) {
  const [planID] = args
  const plan = getPlanByID(planID)
  if (!plan.sponsor === user.id) return log({ type: 'chain', data: [`Only a sponsor is allowed to unpublish the plan`] })
  cancelContracts(plan) // remove all hosted and draft contracts
}
/*----------------------
  (UN)REGISTER ROLES
------------------------*/
async function registerRole (user, role, log) {
  const userID = user.id
  // registered.push(role)
  if (!user[role]) {
    user[role] = {
      jobs: {},
      challenges: {},
      capacity: 5, // TODO: calculate capacity for each job based on the form
    }
  }
  const first = role[0].toUpperCase()
  const rest = role.substring(1)
  DB.status[`idle${first + rest}s`].push(userID)
  try_next_amendment(log)
  // TODO: replace with: `findNextJob()`
  // tryNextChallenge({ attestorID: userID }, log) // check for attestor only jobs (storage & perf challenge)
  emitEvent(`RegistrationSuccessful`, [role, userID], log)
}

/*----------------------
  AMENDMENT REPORT
------------------------*/
async function _amendment_report (user, { name, nonce }, status, args) {
  const log = connections[name].log
  const [ report ] = args
  const { id: amendmentID, failed, sigs } = report // [2,6,8]
  const amendment = getAmendmentByID(amendmentID)
  const { providers: { hosters, attestors, encoders }, contract: contractID } = amendment
  if (!sigs_verified(sigs, hosters, amendmentID)) return log({ type: 'chain', data: [`Error: unique_el_signature could not be verified`] })
  log({ type: 'chain', data: [`amendmentReport hoster signatures verified`] })
  const contract = getContractByID(contractID)
  const { status: { schedulerID }, plan: planID } = contract
  const plan = getPlanByID(planID)
  const [attestorID] = attestors
  if (user.id !== attestorID) return log({ type: 'chain', data: [`Error: this user can not submit the attestation, ${JSON.stringify(attestors)}, ${user.id}`] })
  if (contract.amendments[contract.amendments.length - 1] !== amendmentID) return log({ type: 'chain', data: [`Error: this amendment has expired`] })
  // cancel amendment schedule
  const { cancelAction } = await scheduler
  if (!schedulerID) console.log('No scheduler in', JSON.stringify(contract))
  cancelAction(schedulerID)
  
  // ALL SUCCESS 
  if (!failed.length) {
    contract.activeHosters = hosters // TODO could get this infor from active_amendment.providers.hosters
    for (var i = 0, len = hosters.length; i < len; i++) {
      const hosterID = hosters[i]
      const user = getUserByID(hosterID)
      const jobs = Object.keys(user.hoster.jobs).map(job => Number(job))
      console.log(`Hosting started: contract: ${contractID}, amendment: ${amendmentID}, hoster: ${hosters[i]}, jobs: ${jobs}`)
      start_storage_challenges(user, log)
    }
    encoders.forEach(id => {
      removeJob({ id, role: 'encoder', doneJob: amendmentID, idleProviders: DB.status.idleEncoders, action: () => try_next_amendment(log) }, log)
    })
    attestors.forEach(id => {
      removeJob({ id, role: 'attestor', doneJob: amendmentID, idleProviders: DB.status.idleAttestors, action: () => try_next_amendment(log) }, log)
    })
    
    const feed = getFeedByID(contract.feed)
    
    // feed.contracts.push(contractID)
    // if (feed.contracts.length === 1) schedule_perf_challenges(feed, meta, log)
    
    // => until HOSTING STARTED event, everyone keeps the data around
    emitEvent('HostingStarted', [amendmentID], log)
    return
  }
  // NOT ALL SUCCESS => new amendment
  const attestor = user
  const meta = [attestor, name, nonce, status]
  const opts = { failed, amendment, contractID, plan, meta, log }
  retryAmendment(opts)
}


/*----------------------
  STORAGE CHALLENGE
------------------------*/
function make_storage_challenge ({hoster_id, log}) {
  // select an attestor
  // tell them which hoster to challenge
  // tell them which subset of contracts & chunks to challenge
  const jobs = Object.keys(getUserByID(hoster_id).hoster.jobs).map(job => Number(job))
  console.log('Making new storage challenge for', {hoster_id, jobs })
  if (!jobs.length) return
  const contracts_ids = jobs.map(id => getAmendmentByID(id).contract)
  const selected = get_random_ids({ items: contracts_ids, max: 5 })
  const checks = {}
  const avoid = {}
  for (var i = 0, len = selected.length; i < len; i++) {
    const contractID = selected[i]
    const { plan, ranges } = getContractByID(contractID)
    avoid[plan.sponsor] = true
    checks[contractID] = { index: getRandomChunk(ranges) }
  }
  const storage_challenge = { checks, hoster: hoster_id }
  const id = addItem(storage_challenge)
  DB.active.storageChallenges[id] = true
  // find & book the attestor
  const newJob = id
  const type = 'NewStorageChallenge'
  avoid[hoster_id] = true
  const idleProviders = DB.status.idleAttestors
  const selectedProviders = select({ idleProviders, role: 'attestor', newJob, amount: 1, avoid, plan: {}, log })
  const [attestor] = selectedProviders
  if (!attestor) return DB.queues.attestorsJobQueue.push({ fnName: 'NewStorageChallenge', opts: { storageChallenge } })
  storage_challenge.attestor = attestor.id
  giveJobToRoles({ type, selectedProviders, idleProviders, role: 'attestor', newJob }, log)
  // emit event
  log({ type: 'chain', data: [type, newJob] })
  emitEvent(type, [newJob], log)
}

async function _storage_challenge_report (user, { name, nonce }, status, args) {
  const log = connections[name].log
  const [ response ] = args
  log({ type: 'chain', data: [`Received StorageChallenge ${JSON.stringify(response)}`] })

  // const { storageChallengeID, reports } = response
  const { reports, storage_challenge_signature, storageChallengeID } = response
  const { checks, attestor: attestorID, hoster: hosterID } = getStorageChallengeByID(storageChallengeID)
  if (user.id !== attestorID) return log({ type: 'chain', data: [`Only the attestor can submit this storage challenge`] })
  
  for (var i = 0, len = reports.length; i < len; i++) {
    const { contractID, version, nodes } = reports[i]
    const check = checks[contractID]
    if (!check) return console.log('error, there is no check for this contractID')
    const { signingKey } = getUserByID(hosterID)
    const { feed: feedID } = getContractByID(contractID)
    const { feedkey, signatures } = getFeedByID(feedID)
    const index = check.index
    const messageBuf = Buffer.alloc(varint.encodingLength(storageChallengeID))
    varint.encode(storageChallengeID, messageBuf, 0)
    const signingKeyBuf = Buffer.from(signingKey, 'binary')
    const datdot_crypto = require('../../src/node_modules/datdot-crypto')

    if (!datdot_crypto.verify_signature(storage_challenge_signature, messageBuf, signingKeyBuf)) return emitEvent('StorageChallengeFailed', [storageChallengeID], log)
    const signatureBuf = Buffer.from(signatures[version], 'binary')
    const keyBuf = Buffer.from(feedkey, 'hex')
    const not_verified = datdot_crypto.merkle_verify({
      feedKey: keyBuf, 
      hash_index: index * 2, 
      version, 
      signature: signatureBuf, 
      nodes
    })
    if (not_verified) return emitEvent('StorageChallengeFailed', [storageChallengeID], log)
    console.log('storage confirmed for:', {contractID, hosterID, check})
  }
  // @NOTE: sizes for any required proof hash is already on chain
  // @NOTE: `feed/:id/chunk/:v` // size
  console.log('StorageChallengeConfirmed')
  emitEvent('StorageChallengeConfirmed', [storageChallengeID], log)
  // attestor finished job, add them to idleAttestors again
  removeJob({ id: attestorID, role: 'attestor', doneJob: storageChallengeID, idleProviders: DB.status.idleAttestors, action: () => tryNextChallenge({ attestorID }, log) }, log)
}

/*----------------------
  PERFORMANCE CHALLENGE
------------------------*/
async function _requestPerformanceChallenge ({ contractID, hosterID, meta, log }) {
  const [user, name, nonce, status] = meta
  const contract = getContractByID(contractID)
  const plan = getPlanByID(contract.plan)
  makePerformanceChallenge({ contractID, hosterID, plan }, log)
}

async function _submitPerformanceChallenge (user, { name, nonce }, status, args) {
  const log = connections[name].log
  const [ performanceChallengeID, report ] = args
  const userID = user.id
  log({ type: 'chain', data: [`Performance Challenge proof by attestor: ${userID} for challenge: ${performanceChallengeID}`] })
  const performanceChallenge = getPerformanceChallengeByID(performanceChallengeID)
  if (!performanceChallenge.attestors.includes(userID)) return log({ type: 'chain', data: [`Only selected attestors can submit this performance challenge`] })
  
  const { stats, signed_event } = report
  // if (!is_valid_signature(signed_event)) return
  var method = report ? 'PerformanceChallengeFailed' : 'PerformanceChallengeConfirmed'
  if (report) console.log('------ Performance challenge confirmed')
  emitEvent(method, [performanceChallengeID], log)
  // attestor finished job, add them to idleAttestors again
  removeJob({ id: userID, role: 'attestor', doneJob: performanceChallengeID, idleProviders: DB.status.idleAttestors, action: () => tryNextChallenge({ attestorID: userID }, log) }, log)
}

/******************************************************************************
  HELPERS
******************************************************************************/

const setSize = 10 // every contract is for hosting 1 set = 10 chunks
const size = setSize*64 //assuming each chunk is 64kb
const blockTime = 6000

async function publish_feed (feed, sponsor_id, log) {
  const { feedkey, swarmkey } = feed
  const feedkeyBuf = Buffer.from(feedkey, 'hex')
  const swarmkeyBuf = Buffer.from(swarmkey, 'hex')
  // check if feed already exists
  if (DB.lookups.feedByKey[feedkeyBuf.toString('hex')]) return
  feed = { feedkey: feedkeyBuf.toString('hex'), swarmkey: swarmkeyBuf.toString('hex'), signatures: {}, contracts: [] }
  const feedID = addItem(feed)
  DB.lookups.feedByKey[feedkeyBuf.toString('hex')] = feedID
  feed.publisher = sponsor_id
  emitEvent('FeedPublished', [feedID], log)
  return feedID
}

function store_root_signatures (proofs, feed_ids) {
  proofs.map(({ feed_ref, signature, nodes }, i) => {
    const indexes = nodes.map(node => node.index)
    const index = Math.max.apply(Math, indexes)/2 // find highest index/2
    const feed_id = feed_ref < 0 ? feed_ids[(Math.abs(feed_ref) - 1)] : feed_ref
    const feed = getFeedByID(feed_id)
    const feedKey = Buffer.from(feed.feedkey, 'hex')
    signature = Buffer.from(signature, 'binary')
    nodes.forEach(node => {
      node.hash = Buffer.from(node.hash, 'hex')
    })
    const not_verified = datdot_crypto.merkle_verify({feedKey, hash_index: index * 2, version: index, signature, nodes})
    if (not_verified) return console.log('proof could not be verified')
    feed.signatures[index] = signature
  })
}

async function publish_plan_components (log, components, feed_ids) {
  const { dataset_items, performance_items, timetable_items, region_items } = components
  const dataset_ids = await Promise.all(dataset_items.map(async item => {
    if (item.feed_id < 0) item.feed_id = feed_ids[(Math.abs(item.feed_id) - 1)]
    return addItem(item)
  }))
  const performances_ids = await Promise.all(performance_items.map(async item => addItem(item)))
  const timetables_ids = await Promise.all(timetable_items.map(async item => addItem(item)))
  const regions_ids = await Promise.all(region_items.map(async item => addItem(item)))
  return { dataset_ids, performances_ids, timetables_ids, regions_ids }
} 
async function publish_form_components (components) {
  const {  timetable_items, region_items, performance_items, resource_items } = components
  const timetables_ids = await Promise.all(timetable_items.map(async item => addItem(item)))
  const regions_ids = await Promise.all(region_items.map(async item => addItem(item)))
  const performances_ids = await Promise.all(performance_items.map(async item => addItem(item)))
  const resources_ids = await Promise.all(resource_items.map(async item => addItem(item)))
  return { resources_ids, performances_ids, timetables_ids, regions_ids }
}
function handleNew (item, ids) {
  const keys = Object.keys(item)
  for (var i = 0, len = keys.length; i < len; i++) {
    const type = keys[i]
    item[type] = item[type].map(id => {
      if (id < 0) return ids[`${type}_ids`][(Math.abs(id) - 1)]
    })
  }
  return item
}

function getPrograms (plans) {
  const programs = []
  for (var i = 0; i < plans.length; i++) { programs.push(...plans[i].programs) }
  return programs
}

async function take_next_from_priority (next, log) {
  const plan = await getPlanByID(next.id)
  const contract_ids = await make_contracts(plan, log)
  plan.contracts.push(...contract_ids)
  for (var i = 0, len = contract_ids.length; i < len; i++) {
    const contract_id = contract_ids[i]
    const blockNow = header.number
    const delay = plan.duration.from - blockNow
    const { scheduleAction } = await scheduler
    scheduleAction({ 
      from: log.path,
      data: { contract_id }, 
      delay, type: 'plan_execution' 
    })
  }
}

// split plan into sets with 10 chunks
async function make_contracts (plan, log) {
  const dataset_ids = plan.program.map(item => item.dataset).flat()
  const datasets = get_datasets(plan)
  for (var i = 0; i < datasets.length; i++) {
    const feed = getFeedByID(datasets[i].feed_id)
    const ranges = datasets[i].ranges
    // split ranges to sets (size = setSize)
    const sets = makeSets({ ranges, setSize })
    return Promise.all(sets.map(async set => {
      // const contractID = DB.contracts.length
      const contract = {
        plan: plan.id,
        feed: feed.id,
        ranges: set,
        amendments: [],
        activeHosters: [],
        status: {}
       }
      addItem(contract)
      log({ type: 'chain', data: [`New Contract: ${JSON.stringify(contract)}`] })
      return contract.id 
    }))
  }
}
// find providers for each contract (+ new providers if selected ones fail)
async function init_amendment (contractID, reuse, log) {
  console.log('initializing amendment')
  const contract = getContractByID(contractID)
  if (!contract) return log({ type: 'chain', data: [`No contract with this ID: ${contractID}`] })
  log({ type: 'chain', data: [`Init amendment & find additional providers for contract: ${contractID}`] })
  // const id = DB.amendments.length
  const amendment = { contract: contractID }
  // DB.amendments.push(amendment) // @NOTE: set id
  const id = addItem(amendment)
  amendment.providers = reuse
  contract.amendments.push(id)
  return id
}

function add_to_pending (amendmentID) {
  DB.queues.pendingAmendments.push(amendmentID) // TODO sort pendingAmendments based on priority (RATIO!)
}

async function try_next_amendment (log) {
  const failed = []
  for (var start = new Date(); DB.queues.pendingAmendments.length && new Date() - start < 4000;) {
    const id = DB.queues.pendingAmendments.shift()
    await activate_amendment(id, log).catch(failed_id => failed.push(failed_id)) 
  }
  failed.forEach(id => add_to_pending(id))
}

async function activate_amendment (id, log) {
  return new Promise(async (resolve, reject) => {
    const amendment = getAmendmentByID(id)
    const contract = getContractByID(amendment.contract)
    const { plan: plan_id } = getContractByID(amendment.contract)
    const newJob = id
    const type = 'NewAmendment'
    const providers = getProviders(getPlanByID(plan_id), amendment.providers, newJob, log)
    if (!providers) {
      console.log('not enough providers')
      log({ type: 'chain', data: [`not enough providers available for this amendment`] })
      return reject(id)
    }
    // console.log({providers})
    // schedule follow up action
    contract.status.schedulerID = await scheduleAmendmentFollowUp(id, log)
    ;['attestor','encoder','hoster'].forEach(role => {
      const first = role[0].toUpperCase()
      const rest = role.substring(1)
      giveJobToRoles({
        type,
        selectedProviders: providers[`${role}s`],
        idleProviders: DB[`idle${first + rest}s`],
        role,
        newJob
      }, log)
    })
    const keys = Object.keys(providers)
    for (var i = 0, len = keys.length; i < len; i++) {
      providers[keys[i]] = providers[keys[i]].map(item => item.id)
    }
    log({ type: 'chain', data: [`Providers for amendment (${id}): ${JSON.stringify(providers)}`] })
    amendment.providers = providers
    // emit event
    console.log(`New event emitted`, type, newJob)
    log({ type: 'chain', data: [type, newJob] })
    emitEvent(type, [newJob], log)
    resolve()
  })
}

function getProviders (plan, reused, newJob, log) {
  if (!reused) reused = { encoders: [], attestors: [], hosters: [] }
  const attestorAmount = 1 - (reused.attestors.length || 0)
  const encoderAmount = 3 - (reused.encoders.length || 0)
  const hosterAmount = 3 - (reused.hosters.length || 0)
  const avoid = makeAvoid(plan)
  reused.encoders.forEach(id =>  avoid[id] = true)
  reused.attestors.forEach(id =>  avoid[id] = true)
  reused.hosters.forEach(id =>  avoid[id] = true)

  // TODO backtracking!! try all the options before returning no providers available
  const attestors = select({ idleProviders: DB.status.idleAttestors, role: 'attestor', newJob, amount: attestorAmount, avoid, plan, log })
  if (!attestors.length) return log({ type: 'chain', data: [`missing attestors`] })
  const encoders = select({ idleProviders: DB.status.idleEncoders, role: 'encoder',  newJob, amount: encoderAmount, avoid, plan, log })
  if (encoders.length !== encoderAmount) return log({ type: 'chain', data: [`missing encoders`] })
  const hosters = select({ idleProviders: DB.status.idleHosters, role: 'hoster', newJob, amount: hosterAmount, avoid, plan, log })
  if (hosters.length !== hosterAmount) return log({ type: 'chain', data: [`missing hosters`] })

  return {
    encoders: [...encoders, ...reused.encoders],
    hosters: [...hosters, ...reused.hosters],
    attestors: [...attestors, ...reused.attestors]
  }
}
function getRandomIndex(range) {
  const min = range[0]
  const max = range[1]+1
  return Math.floor(Math.random() * (max - min)) + min; //The maximum is exclusive and the minimum is inclusive
}
function getRandomChunk (ranges) { // [[0,3], [5,7]]
  const start = 0
  const end = ranges.length
  const range = ranges[Math.floor(Math.random() * (end - start)) + start]
  return getRandomIndex(range)
}
function select ({ idleProviders, role, newJob, amount, avoid, plan, log }) {
  idleProviders.sort(() => Math.random() - 0.5) // TODO: improve randomness
  const selectedProviders = []
  for (var i = 0; i < idleProviders.length; i++) {
    const id = idleProviders[i]
    if (avoid[id]) continue // if id is in avoid, don't select it
    const provider = getUserByID(id)
    if (doesQualify(plan, provider, role)) {
      selectedProviders.push({id, index: i, role })
      avoid[id] = true
      if (selectedProviders.length === amount) return selectedProviders
    }
  }
  return []
}
function giveJobToRoles ({ type, selectedProviders, idleProviders, role, newJob }, log) {
  // @NOTE: sortedProviders makes sure those with highest index get sliced first
  // so lower indexes are unchanged until they get sliced too
  const sortedProviders = selectedProviders.sort((a,b) => a.index > b.index ? 1 : -1)
  const providers = sortedProviders.map(({ id, index, role }) => {
    const provider = getUserByID(id)
    provider[role].jobs[newJob] = true
    if (!hasCapacity(provider, role)) idleProviders.splice(index, 1)
    // TODO currently we reduce idleStorage for all providers
    // and for all jobs (also challenge)
    // => take care that it is INCREASED again when job is done
    provider.idleStorage -= size
    return id
  })
  // returns array of selected providers for select function
  return providers
}


function getJobByID (jobID) {
  return getItem(jobID)
}
// TODO payments: for each successfull hosting we pay attestor(1/3), this hoster (full), encoders (full, but just once)
async function removeJob ({ providers, jobID }, log) {
  const job = await getJobByID(jobID)
  const types = Object.keys(provider)
  for (var i = 0, ilen = types.length; i < len; i++) {
    const roles = types[i]//.slice(0, -1)
    const peerIDs = providers[roles]
    for (var k = 0, klen = peerIDs.length; k < klen; k++) {
      const id = peerIDs[k]

    }
  }
}

function removeJob ({ id, role, doneJob, idleProviders, action }, log) {
  const provider = getUserByID(id)
  if (provider[role].jobs[doneJob]) {
    log({ type: 'chain', data: [`Removing the job ${doneJob}`] })
    delete provider[role].jobs[doneJob]
    if (!idleProviders.includes(id)) idleProviders.push(id)
    provider.idleStorage += size
    action()
  }
}
function doesQualify (plan, provider, role) {
  const form = provider.form
  if (
    isScheduleCompatible(plan, form, role) &&
    hasCapacity(provider, role) &&
    hasEnoughStorage(provider)
  ) return true
}
async function isScheduleCompatible (plan, form, role) {
  const blockNow = header.number
  const isAvialableNow = form.duration.from <= blockNow
  const until = form.duration.until
  var jobDuration
  if (role === 'attestor') jobDuration = 3
  if (role === 'encoder') jobDuration = 2 // duration in blocks
  if (role === 'hoster') jobDuration = plan.duration.until -  blockNow
  return (isAvialableNow && (until >= (blockNow + jobDuration) || isOpenEnded))
}
function hasCapacity (provider, role) {
  const jobs = provider[role].jobs
  return (Object.keys(jobs).length < provider[role].capacity)
}
function hasEnoughStorage (provider) {
  return (provider.idleStorage > size)
}
function tryNextChallenge ({ attestorID }, log) {
  if (DB.queues.attestorsJobQueue.length) {
    const next = DB.queues.attestorsJobQueue[0]
    if (next.fnName === 'NewStorageChallenge' && DB.status.idleAttestors.length) {
      const storageChallenge = next.opts.storageChallenge
      const hosterID = storageChallenge.hoster
      const contract = getContractByID(storageChallenge.contract)
      const plan = getPlanByID(contract.plan)
      const avoid = makeAvoid(plan)
      avoid[hosterID] = true

      const newJob = storageChallenge.id
      const type = 'NewStorageChallenge'
      const idleProviders = DB.status.idleAttestors
      const selectedProviders = select({ idleProviders, role: 'attestor', newJob, amount: 1, avoid, plan, log })
      const [attestor] = selectedProviders
      if (selectedProviders.length) {
        DB.queues.attestorsJobQueue.shift()
        storageChallenge.attestor = attestor.id
        giveJobToRoles({ type, selectedProviders, idleProviders, role: 'attestor', newJob }, log)
      }
      // emit event
      log({ type: 'chain', data: [type, newJob] })
      emitEvent(type, [newJob], log)
    }
    if (next.fnName === 'NewPerformanceChallenge' && DB.status.idleAttestors.length >= 5) {
      const performanceChallenge = next.opts.performanceChallenge
      const hosterID = performanceChallenge.hoster
      const contract = getContractByID(performanceChallenge.contract)
      const plan = getPlanByID(contract.plan)
      const avoid = makeAvoid(plan)
      avoid[hosterID] = true

      const newJob = performanceChallenge.id
      const type = 'NewPerformanceChallenge'
      const attestors = select({ idleProviders: DB.status.idleAttestors, role: 'attestor', newJob, amount: 5, avoid, plan, log })
      if (attestors.length) {
        DB.queues.attestorsJobQueue.shift()
        performanceChallenge.attestors = attestors.map(attestor => attestor.id)
        giveJobToRoles({
          type,
          selectedProviders: attestors,
          idleProviders: DB.status.idleAttestors,
          role: 'attestor',
          newJob
        }, log)
        // emit event
        log({ type: 'chain', data: [type, newJob] })
        emitEvent(type, [newJob], log)
      }
    }
  }
}
function makeAvoid (plan) {
  const avoid = {}
  avoid[plan.sponsor] = true // avoid[3] = true
  return avoid
}
function sigs_verified (sigs, hosters, amendmentID) {
  for (var i = 0, len = sigs.length; i < len; i++) {
    const { unique_el_signature, hoster: id } = sigs[i]
    if (hosters.includes(id)) {
      const { signingKey }  = getUserByID(id)
      const pos = hosters.indexOf(hoster)
      const data = Buffer.from(`${amendmentID}/${pos}`, 'binary')
      if (!datdot_crypto.verify_signature(unique_el_signature, data, signingKey)) return log({ type: 'chain', data: [`Error: unique_el_signature could not be verified`] })
    }
  }
  return true
}
function cancelContracts (plan) {
  const contracts = plan.contracts
  for (var i = 0; i < contracts.length; i++) {
    const contractID = contracts[i]
    const contract = getContractByID(contractID)
    // tell hosters to stop hosting
    // TODO:
    // 1. figure out all active Hostings (=contracts) from plan (= active)
    // 2. figure out all WIP PerfChallenges for contracts from plan
    // 3. figure out all WIP StoreChallenges for contracts from plan
    // 4. figure out all WIP makeHosting (=amendments) from plan (= soon to become active)
    // 5. CHAIN ONLY: figure out all future scheduled makeHostings (=amendments) from plan

// for every hoster in last Amendment user.hoster.jobs[`NewAmendment${amendmentID}`] = false
// for every encoder in last  user.encoder.jobs[`NewAmendment${amendmentID}`] = false
// for every attestor in last  user.attestor.jobs[`NewAmendment${amendmentID}`] = false
// contract.activeHosters = []
// cancel scheduled challenges
// plan.contracts = [] => we need to rename to activeContracts
// add checks in extrinsics for when wip actions (make hostings, challenges) report back to chain =>
//     storageChallengeID
// if (DB.active.storageChallenges[id] ) const challenge = getStorageChallengeByID(storageChallengeID)

    const queue = priorityQueue(function compare (a, b) { return a.id < b.id ? -1 : 1 })
    // queue.size()
    // queue.add(item) // add item at correct position into queue
    // queue.take(index=0) // get front item and remove it from the queue
    // queue.peek(index=0) // check front item
    // queue.drop(function keep (x) { return item.contract !== id })


    contract.activeHosters.forEach((hosterID, i) => {
    removeJob({
      id: hosterID,
      role: 'hoster',
      doneJob: contractID,
      idleProviders: DB.status.idleHosters,
      action: () => try_next_amendment(log)
    }, log)
      const { feed: feedID } = getContractByID(contractID)
      // TODO ACTION find new provider for the contract (makeAmendment(reuse))
      // emit event to notify hoster(s) to stop hosting
      emitEvent('DropHosting', [feedID, hosterID], log)
    })
    contract.activeHosters = []
    // remove from jobs queue
    for (var j = 0; j < DB.queues.pendingAmendments; j++) {
      const id = DB.queues.pendingAmendments[j]
      const amendment = getAmendmentByID(id)
      if (contractID === amendment.contract) DB.queues.pendingAmendments.splice(j, 1)
    }
  }
}

async function start_storage_challenges (user, log) {
  const { scheduleAction } = await scheduler // @TODO: 
  // see if user.hoster has active challenges
  if (user.hoster.challenges.storage) return
  // if no active challenges, start a challenge
  make_storage_challenge({ hoster_id: user.id, log })
  // set a followup (usign scheduler)
  scheduleAction({ from: log.path, data: {}, delay: 1, type: 'storage_challenge_followup' })

  challenge(user)
  async function challenge (user) {
    // start new challenge (check all the feeds hoster hosts)
    user.hoster.challenges.storage = true
    scheduleAction({ from: log.path, data: { user }, delay: 1, type: 'execute_storage_challenge' })
  }
}

function get_random_ids ({items, max}) {
  if (items.length < max) return items
  const selected = []
  while (selected.length < max) {
    const pos = Math.floor(Math.random() * items.length)
    if (!selected.includes(pos)) selected.push(pos)
  }
  return selected.map(pos => items[pos])
}

// TODO
// performance challenge 
  // group all challenges for same feed (all through same swarm) -> feed has many hosters (feed.contracts)
// storage challenge - group all challenges for same hoster (all through same beam connection) -> hoster hosts many feeds (user.hoster.jobs[amendmentID])

async function scheduleAmendmentFollowUp (id, log) {
  const { scheduleAction } = await scheduler
  var sid = scheduleAction({ from: log.path, data: {}, delay: 10, type: 'amendment_followup' })
  return sid
}

async function planValid ({ plan }) {
  const blockNow = header.number
  const { duration: { from, until } } = plan
  if ((until > from) && ( until > blockNow)) return true
}

async function retryAmendment (opts) {
  console.log('RETRY AMENDMENT')
  const { failed, amendment, contractID, plan, meta, log } = opts
  var reuse
  const [peerID] = failed
  const { hosters, attestors, encoders } = amendment.providers

  if (attestors.includes(peerID)) {
    // if failed is attestor (report was automatically triggered by amendmentFollowUp)
    const successfulAttestors = attestors.filter(id => !failed.includes(id))
    reuse = { hosters, encoders, attestors: successfulAttestors }
  }
  else if (hosters.includes(peerID)) {
    // else if any of the failed users is a hoster, we know all others did their job and can be reused
    const successfulHosters = hosters.filter(id => !failed.includes(id))
    contract.activeHosters = [...contract.activeHosters, ...successfulHosters]
    for (var i = 0, len = successfulHosters.length; i < len; i++) {
      console.log(`Hosting started: contract: ${contractID}, amendment: ${amendment.id}, hoster: ${successfulHosters[i]}`)
      // const data = { plan, hosterID: successfulHosters[i], contractID, meta, log }
      // scheduleChallenges(data)
    }
    reuse = { hosters: successfulHosters, encoders, attestors }
  } else if (encoders.includes(peerID)) {
    // if any of the encoders failed, we know attestor couldn't compare the encoded chunks and couldn't send them to hosters
    // we know all hosters are good, they can be reused
    const successfulEncoders = encoders.filter(id => !failed.includes(id))
    reuse = { hosters, encoders: successfulEncoders, attestors }

  }
  // remove jobs from providers
  hosters.forEach(id => {
    removeJob({ id, role: 'hoster', doneJob: amendment.id, idleProviders: DB.status.idleHosters, action: () => try_next_amendment(log) }, log)
  })
  encoders.forEach(id => {
    removeJob({ id, role: 'encoder', doneJob: amendment.id, idleProviders: DB.status.idleEncoders, action: () => try_next_amendment(log) }, log)
  })
  attestors.forEach(id => {
    removeJob({ id, role: 'attestor', doneJob: amendment.id, idleProviders: DB.status.idleAttestors, action: () => try_next_amendment(log) }, log)
  })
  // TODO: ... who should drop jobs when??? ...
  // => emit Event to STOP JOB for EVERYONE who FAILED
  emitEvent('DropJob', [amendment.id, failed], log)
  // TODO: add new amendment to contract only after it is taken from the queue
  // TODO: make amendments small (diffs) and show latest summary of all amendments under contract.activeHosters
  
  // make new amendment
  console.log({reuse})
  const newID = await init_amendment(contractID, reuse, log)
  // TODO ACTION find new provider for the contract (makeAmendment(reuse))
  add_to_pending(newID)
  try_next_amendment(log)
}

async function makePerformanceChallenge ({ contractID, hosterID, plan }, log) {
  // const id = DB.performanceChallenge.length
  const performanceChallenge = { contract: contractID, hoster: hosterID }
  // DB.performanceChallenges.push(performanceChallenge) // @NOTE: set id
  const id = addItem(performanceChallenge)
  DB.active.performanceChallenges[id] = true
  // find attestors
  const avoid = makeAvoid(plan)
  avoid[hosterID] = true

  const newJob = performanceChallenge.id
  const type = 'NewPerformanceChallenge'
  const idleProviders = DB.status.idleAttestors
  const attestors = select({ idleProviders, role: 'attestor', newJob, amount: 5, avoid, plan, log })
  if (!attestors.length) return DB.queues.attestorsJobQueue.push({ fnName: 'NewPerformanceChallenge', opts: { performanceChallenge } })
  performanceChallenge.attestors = attestors.map(attestor => attestor.id)
  giveJobToRoles({ type, selectedProviders: attestors, idleProviders, role: 'attestor', newJob }, log)
  // emit event
  log({ type: 'chain', data: [type, newJob] })
  emitEvent(type, [newJob], log)
}

function isValidHoster ({ hosters, failedHosters, hosterID }) {
  // is hoster listed in the amendment for hosting and is hoster not listed as failed (by the attestor)
  if (!hosters.includes(hosterID) || failedHosters.includes(hosterID)) return log({ type: 'chain', data: [`Error: this user can not call this function`] })
  return true
}

function emitEvent (method, data, log) {
  const message = [{ event: { data, method } }]
  handlers.forEach(([name, handler]) => handler(message))
  log({ type: 'chain', data: [`emit chain event ${JSON.stringify(message)}`] })
}

function get_datasets (plan) {
  const dataset_ids = plan.program.map(item => item.dataset).flat()
  return dataset_ids.map(id => getDatasetByID(id))
}
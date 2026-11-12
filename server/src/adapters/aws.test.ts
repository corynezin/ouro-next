import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awsCredentialsProblem, iniSection, realAwsTools, sigV4Authorization, stsHeaders, withIniSection } from './aws.ts'
import type { SigningCredentials } from './aws.ts'
import { ProviderUnreachable } from './provider-outcome.ts'

test("a request is signed as AWS's own Signature Version 4 test suite says (get-vanilla)", () => {
  const authorization = sigV4Authorization(
    { method: 'GET', host: 'example.amazonaws.com', path: '/', query: '', headers: {}, body: '', region: 'us-east-1', service: 'service', amzDate: '20150830T123600Z' },
    { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  )
  assert.equal(authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
})

test('only a long-lived access key, a secret and a region are taken', () => {
  const good = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' }
  assert.equal(awsCredentialsProblem(good), null)
  assert.equal(awsCredentialsProblem({ ...good, region: 'ap-southeast-2' }), null)
  assert.match(awsCredentialsProblem({ ...good, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' })!, /temporary/)
  assert.match(awsCredentialsProblem({ ...good, accessKeyId: 'ghp_nope' })!, /access key id/)
  assert.match(awsCredentialsProblem({ ...good, secretAccessKey: 'short' })!, /secret/)
  assert.match(awsCredentialsProblem({ ...good, region: 'Virginia' })!, /region/)
})

test('changing the default profile leaves every other profile and comment as it was', () => {
  const before = '# mine\n[work]\naws_access_key_id = AKIAWORK\n\n[default]\nregion = eu-west-1\noutput = json\n\n[other]\nx = 1\n'
  const set = withIniSection(before, 'default', { region: 'us-east-1', aws_access_key_id: 'AKIANEW' })
  assert.equal(set, '# mine\n[work]\naws_access_key_id = AKIAWORK\n\n[default]\nregion = us-east-1\noutput = json\naws_access_key_id = AKIANEW\n\n[other]\nx = 1\n')
  assert.deepEqual(iniSection(set, 'default'), { region: 'us-east-1', output: 'json', aws_access_key_id: 'AKIANEW' })
  assert.deepEqual(iniSection(set, 'work'), { aws_access_key_id: 'AKIAWORK' })
  // Emptied, the section goes; the others stay.
  assert.equal(withIniSection(set, 'default', { region: null, output: null, aws_access_key_id: null }), '# mine\n[work]\naws_access_key_id = AKIAWORK\n\n[other]\nx = 1\n')
  assert.equal(withIniSection('', 'default', { region: 'us-east-1' }), '[default]\nregion = us-east-1\n')
  assert.equal(withIniSection('[work]\na = 1\n', 'default', { region: 'us-east-1' }), '[work]\na = 1\n\n[default]\nregion = us-east-1\n')
  assert.equal(withIniSection('[work]\na = 1\n', 'default', { region: null }), '[work]\na = 1\n')
})

test('a key AWS accepts becomes the default profile, readable only by its owner, and disconnecting removes only it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-aws-'))
  const files = { credentials: join(dir, '.aws', 'credentials'), config: join(dir, '.aws', 'config') }
  let reachable = true
  const tools = realAwsTools(files, async ({ secretAccessKey }) => {
    if (!reachable) throw new ProviderUnreachable("couldn't reach AWS to check the key; try again")
    return secretAccessKey.startsWith('good')
      ? { kind: 'known', accountId: '111122223333', arn: 'arn:aws:iam::111122223333:user/agents' }
      : { kind: 'refused', why: 'AWS rejected that key' }
  })
  const key = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'good/K7MDENG/bPxRfiCYEXAMPLEKEY000', region: 'eu-central-1' }

  assert.deepEqual(await tools.awsStatus(), { status: 'not_connected' })
  assert.deepEqual(await tools.awsSetCredentials({ ...key, secretAccessKey: 'bad/K7MDENG/bPxRfiCYEXAMPLEKEY0000' }), { accepted: false, why: 'AWS rejected that key' })
  assert.deepEqual(await tools.awsStatus(), { status: 'not_connected' }, 'a refused key is not kept')

  assert.deepEqual(await tools.awsSetCredentials(key), { accepted: true })
  assert.equal(statSync(files.credentials).mode & 0o777, 0o600)
  assert.deepEqual(await tools.awsStatus(), {
    status: 'connected', accessKeyId: 'AKIA…MPLE', region: 'eu-central-1', accountId: '111122223333', arn: 'arn:aws:iam::111122223333:user/agents', problem: null,
  })
  reachable = false
  assert.deepEqual(await tools.awsStatus(), {
    status: 'connected', accessKeyId: 'AKIA…MPLE', region: 'eu-central-1', accountId: null, arn: null, problem: "couldn't reach AWS to check the key; try again",
  })

  writeFileSync(files.credentials, `${readFileSync(files.credentials, 'utf8')}\n[personal]\naws_access_key_id = AKIAPERSONAL\n`)
  await tools.awsDisconnect()
  assert.deepEqual(await tools.awsStatus(), { status: 'not_connected' })
  assert.equal(readFileSync(files.credentials, 'utf8'), '[personal]\naws_access_key_id = AKIAPERSONAL\n')
})

test('temporary credentials someone put in the default profile are checked with their session token, which is signed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-aws-'))
  const files = { credentials: join(dir, 'credentials'), config: join(dir, 'config') }
  writeFileSync(files.credentials, '[default]\naws_access_key_id = ASIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\naws_session_token = FwoGZXIvYXdzEXAMPLETOKEN\n')
  const asked: SigningCredentials[] = []
  const tools = realAwsTools(files, async (credentials) => {
    asked.push(credentials)
    return { kind: 'known', accountId: '111122223333', arn: 'arn:aws:sts::111122223333:assumed-role/dev/me' }
  })
  const status = await tools.awsStatus()
  assert.equal(status.status === 'connected' && status.problem, null)
  assert.equal(asked[0]!.sessionToken, 'FwoGZXIvYXdzEXAMPLETOKEN')

  const headers = stsHeaders(asked[0]!)
  assert.equal(headers['x-amz-security-token'], 'FwoGZXIvYXdzEXAMPLETOKEN')
  const signing = { method: 'POST', host: 'sts.amazonaws.com', path: '/', query: '', body: '', region: 'us-east-1', service: 'sts', amzDate: '20150830T123600Z' }
  assert.match(sigV4Authorization({ ...signing, headers }, asked[0]!), /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/)
  assert.equal(stsHeaders({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' })['x-amz-security-token'], undefined, 'a long-lived key sends none')
})

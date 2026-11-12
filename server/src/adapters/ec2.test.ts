import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imagesOf, instanceOf, instancesOf } from './ec2.ts'
import { machineNameOf, sslipAddressOf } from './machine-provisioners.ts'

test("an image list's ids are read with their creation dates", () => {
  const xml = `<DescribeImagesResponse><imagesSet>
    <item><imageId>ami-0old</imageId><imageLocation>x</imageLocation><imageState>available</imageState><creationDate>2026-01-02T00:00:00.000Z</creationDate><tagSet/></item>
    <item><imageId>ami-0new</imageId><imageLocation>y</imageLocation><creationDate>2026-10-30T00:00:00.000Z</creationDate></item>
  </imagesSet></DescribeImagesResponse>`
  assert.deepEqual(imagesOf(xml), [{ imageId: 'ami-0old', createdAt: '2026-01-02T00:00:00.000Z' }, { imageId: 'ami-0new', createdAt: '2026-10-30T00:00:00.000Z' }])
})

test("an instance's state and public IP are read, not its private one", () => {
  const xml = `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-0abc</instanceId>
    <instanceState><code>16</code><name>running</name></instanceState><privateIpAddress>172.31.0.5</privateIpAddress>
    <groupSet><item><groupName>ouro-servers</groupName></item></groupSet><ipAddress>54.1.2.3</ipAddress></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`
  assert.deepEqual(instanceOf(xml), { instanceId: 'i-0abc', state: 'running', publicIp: '54.1.2.3' })
  assert.deepEqual(instanceOf('<x><instanceId>i-1</instanceId><instanceState><code>0</code><name>pending</name></instanceState></x>'), { instanceId: 'i-1', state: 'pending', publicIp: null })
  assert.equal(instanceOf('<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>'), null)
})

test("a new server's name and address come from its label and IP", () => {
  assert.equal(machineNameOf("Sam's Work Box!"), 'sam-s-work-box')
  assert.equal(machineNameOf('———'), 'server')
  assert.equal(sslipAddressOf('54.1.2.3'), 'https://54-1-2-3.sslip.io')
})

test('every instance in an answer is read with its own state, as destroy finds them by tag', () => {
  const xml = `<DescribeInstancesResponse><reservationSet>
    <item><instancesSet><item><instanceId>i-1</instanceId><instanceState><code>16</code><name>running</name></instanceState><ipAddress>54.1.2.3</ipAddress></item></instancesSet></item>
    <item><instancesSet><item><instanceId>i-2</instanceId><instanceState><code>48</code><name>terminated</name></instanceState></item></instancesSet></item>
  </reservationSet></DescribeInstancesResponse>`
  assert.deepEqual(instancesOf(xml), [{ instanceId: 'i-1', state: 'running', publicIp: '54.1.2.3' }, { instanceId: 'i-2', state: 'terminated', publicIp: null }])
  assert.deepEqual(instancesOf('<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>'), [])
})

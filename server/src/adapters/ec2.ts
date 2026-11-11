// The part of the EC2 API that making a server on AWS uses, over its Query API signed with Signature Version 4 (aws.ts),
// with the key AWS is connected with in Settings: the default profile of `~/.aws`. Answers are XML; the few values read
// are picked out of it by their tags.
import { existsSync, readFileSync } from 'node:fs'
import { iniSection, sigV4Authorization } from './aws.ts'
import type { AwsFiles } from './aws.ts'

export class Ec2Error extends Error {
  /** AWS's error code, such as `InvalidGroup.Duplicate`; null when AWS gave none. */
  readonly code: string | null

  constructor(code: string | null, message: string) {
    super(message)
    this.code = code
  }
}

export interface Ec2Credentials { accessKeyId: string; secretAccessKey: string; region: string }

/** The connected key and its region, or null when AWS isn't connected. */
export function ec2CredentialsOf(files: AwsFiles): Ec2Credentials | null {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const keys = iniSection(read(files.credentials), 'default')
  const region = iniSection(read(files.config), 'default').region
  if (!keys.aws_access_key_id || !keys.aws_secret_access_key) return null
  return { accessKeyId: keys.aws_access_key_id, secretAccessKey: keys.aws_secret_access_key, region: region ?? 'us-east-1' }
}

export interface Ec2Instance { instanceId: string; state: string; publicIp: string | null }

export interface Ec2Api {
  /** The newest Ubuntu 24.04 LTS image for x86-64 in the region, from Canonical's own account. */
  latestUbuntuImage(): Promise<string>
  /** The id of a security group named so in the default VPC, open to the internet on these TCP ports; made if missing. */
  ensureSecurityGroup(name: string, description: string, ports: readonly number[]): Promise<string>
  /** One instance. `clientToken` makes it idempotent: asked again with the same token, AWS answers with the same instance. */
  runInstance(request: RunInstanceRequest): Promise<string>
  /** Null when AWS doesn't know the instance (any more). */
  describeInstance(instanceId: string): Promise<Ec2Instance | null>
  /** Terminating one already terminated, or gone, succeeds. */
  terminateInstance(instanceId: string): Promise<void>
}

export interface RunInstanceRequest {
  clientToken: string
  imageId: string
  instanceType: string
  securityGroupId: string
  userData: string
  diskGb: number
  tags: Record<string, string>
}

const VERSION = '2016-11-15'

/** The text of each element with this tag, in order. */
export const tagValues = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => match[1]!)
const tagValue = (xml: string, tag: string): string | null => tagValues(xml, tag)[0] ?? null

/** Each image's id with its creation date: they come in that order within an image's item. */
export function imagesOf(xml: string): { imageId: string; createdAt: string }[] {
  return xml.split('<imageId>').slice(1).flatMap((chunk) => {
    const imageId = chunk.slice(0, chunk.indexOf('<'))
    const createdAt = tagValue(chunk.split('<imageId>')[0]!, 'creationDate')
    return createdAt ? [{ imageId, createdAt }] : []
  })
}

export function instanceOf(xml: string): Ec2Instance | null {
  const instanceId = tagValue(xml, 'instanceId')
  if (!instanceId) return null
  const state = /<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/.exec(xml)?.[1] ?? 'unknown'
  return { instanceId, state, publicIp: tagValue(xml, 'ipAddress') }
}

export class HttpEc2Api implements Ec2Api {
  private readonly credentials: () => Ec2Credentials

  constructor(credentials: () => Ec2Credentials) {
    this.credentials = credentials
  }

  async latestUbuntuImage(): Promise<string> {
    const xml = await this.call('DescribeImages', {
      'Owner.1': '099720109477',
      'Filter.1.Name': 'name', 'Filter.1.Value.1': 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      'Filter.2.Name': 'state', 'Filter.2.Value.1': 'available',
    })
    const newest = imagesOf(xml).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!newest) throw new Ec2Error(null, `AWS lists no Ubuntu 24.04 image in ${this.credentials().region}`)
    return newest.imageId
  }

  async ensureSecurityGroup(name: string, description: string, ports: readonly number[]): Promise<string> {
    let groupId: string | null
    try {
      groupId = tagValue(await this.call('CreateSecurityGroup', { GroupName: name, GroupDescription: description }), 'groupId')
    } catch (error) {
      if (!(error instanceof Ec2Error && error.code === 'InvalidGroup.Duplicate')) throw error
      groupId = tagValue(await this.call('DescribeSecurityGroups', { 'Filter.1.Name': 'group-name', 'Filter.1.Value.1': name }), 'groupId')
    }
    if (!groupId) throw new Ec2Error(null, `AWS didn't say which security group ${name} is`)
    for (const port of ports) {
      try {
        await this.call('AuthorizeSecurityGroupIngress', {
          GroupId: groupId, 'IpPermissions.1.IpProtocol': 'tcp', 'IpPermissions.1.FromPort': String(port), 'IpPermissions.1.ToPort': String(port),
          'IpPermissions.1.IpRanges.1.CidrIp': '0.0.0.0/0',
        })
      } catch (error) {
        if (!(error instanceof Ec2Error && error.code === 'InvalidPermission.Duplicate')) throw error
      }
    }
    return groupId
  }

  async runInstance(request: RunInstanceRequest): Promise<string> {
    const params: Record<string, string> = {
      ClientToken: request.clientToken, ImageId: request.imageId, InstanceType: request.instanceType, MinCount: '1', MaxCount: '1',
      'SecurityGroupId.1': request.securityGroupId, UserData: Buffer.from(request.userData).toString('base64'),
      'BlockDeviceMapping.1.DeviceName': '/dev/sda1', 'BlockDeviceMapping.1.Ebs.VolumeSize': String(request.diskGb),
      'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3', 'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
      'MetadataOptions.HttpTokens': 'required',
      'TagSpecification.1.ResourceType': 'instance',
    }
    Object.entries(request.tags).forEach(([key, value], index) => {
      params[`TagSpecification.1.Tag.${index + 1}.Key`] = key
      params[`TagSpecification.1.Tag.${index + 1}.Value`] = value
    })
    const instanceId = tagValue(await this.call('RunInstances', params), 'instanceId')
    if (!instanceId) throw new Ec2Error(null, "AWS didn't say which instance it started")
    return instanceId
  }

  async describeInstance(instanceId: string): Promise<Ec2Instance | null> {
    try {
      return instanceOf(await this.call('DescribeInstances', { 'InstanceId.1': instanceId }))
    } catch (error) {
      if (error instanceof Ec2Error && error.code === 'InvalidInstanceID.NotFound') return null
      throw error
    }
  }

  async terminateInstance(instanceId: string): Promise<void> {
    try {
      await this.call('TerminateInstances', { 'InstanceId.1': instanceId })
    } catch (error) {
      if (error instanceof Ec2Error && error.code === 'InvalidInstanceID.NotFound') return
      throw error
    }
  }

  private async call(action: string, params: Record<string, string>): Promise<string> {
    const credentials = this.credentials()
    const host = `ec2.${credentials.region}.amazonaws.com`
    const body = new URLSearchParams({ Action: action, Version: VERSION, ...params }).toString()
    const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const authorization = sigV4Authorization({ method: 'POST', host, path: '/', query: '', headers, body, region: credentials.region, service: 'ec2', amzDate }, credentials)
    let response: Response
    try {
      response = await fetch(`https://${host}/`, { method: 'POST', headers: { ...headers, 'x-amz-date': amzDate, authorization }, body, signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new Ec2Error(null, `couldn't reach AWS (${action}): ${(error as Error).message}`)
    }
    const text = await response.text()
    if (!response.ok) {
      const code = tagValue(text, 'Code')
      throw new Ec2Error(code, `AWS refused ${action}: ${code ?? response.status}${tagValue(text, 'Message') ? `: ${tagValue(text, 'Message')}` : ''}`)
    }
    return text
  }
}

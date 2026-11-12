// A row that opens something, with how it stands at the right: "Claude Code     5h 42% · Week 63%  ›".
import { Button, HStack, Image, Spacer, Text } from '@expo/ui/swift-ui'
import { foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers'

export function StatusRow({ title, status, statusColor = 'secondary', onPress }: { title: string; status?: string | null; statusColor?: string; onPress: () => void }) {
  return (
    <Button onPress={onPress}>
      <HStack spacing={8}>
        <Text modifiers={[foregroundStyle('primary')]}>{title}</Text>
        <Spacer />
        {status ? <Text modifiers={[foregroundStyle(statusColor), lineLimit(1)]}>{status}</Text> : null}
        <Image systemName="chevron.right" size={12} modifiers={[foregroundStyle('secondary')]} />
      </HStack>
    </Button>
  )
}

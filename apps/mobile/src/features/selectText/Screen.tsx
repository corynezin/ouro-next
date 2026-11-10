// A message's text in a read-only text view (a sheet), so part of it can be selected and copied.
import { useLayoutEffect } from 'react'
import { TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { C } from '../../design/colors.ts'
import { HeaderButton } from '../../design/form.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'

export function SelectTextScreen({ route, navigation }: ScreenProps<'SelectText'>) {
  const { text } = route.params
  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Select text',
      headerLeft: () => <HeaderButton title="Copy all" onPress={() => { void Clipboard.setStringAsync(text); navigation.goBack() }} />,
      headerRight: () => <HeaderButton title="Done" bold onPress={() => navigation.goBack()} />,
    })
  }, [navigation, text])
  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <TextInput value={text} editable={false} multiline scrollEnabled
        style={{ flex: 1, padding: 16, fontSize: 17, lineHeight: 23, color: C.label, textAlignVertical: 'top' }} />
    </View>
  )
}

// A file sent in a chat: an image full screen with pinch to zoom, anything else in a web view. The share button downloads
// it and opens the share sheet. Every request carries the session's authorisation.
import { useLayoutEffect, useState } from 'react'
import { ActivityIndicator, Alert, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { WebView } from 'react-native-webview'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { C } from '../../design/colors.ts'
import { HeaderIcon } from '../../design/form.tsx'
import { useSession } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { FILE_COPY, sharedFileName } from './model.ts'

async function share(url: string, headers: Record<string, string>, fileName: string) {
  try {
    const destination = new File(Paths.cache, sharedFileName(fileName))
    const downloaded = await File.downloadFileAsync(url, destination, { headers, idempotent: true })
    await Sharing.shareAsync(downloaded.uri)
  } catch (error) {
    Alert.alert(FILE_COPY.shareFailed, (error as Error).message)
  }
}

export function FileScreen({ route, navigation }: ScreenProps<'File'>) {
  const { attachmentId, fileName, isImage } = route.params
  const session = useSession()
  const uri = session.api.attachmentUrl(attachmentId)
  const headers = session.api.authorizationHeaders()
  const { width, height } = useWindowDimensions()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useLayoutEffect(() => {
    navigation.setOptions({
      title: fileName,
      headerRight: () => <HeaderIcon symbol="square.and.arrow.up" onPress={() => { void share(uri, headers, fileName) }} />,
    })
  }, [navigation, fileName, uri, headers])

  if (isImage) return (
    <ScrollView style={{ flex: 1, backgroundColor: 'black' }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
      maximumZoomScale={6} minimumZoomScale={1} centerContent bouncesZoom
      showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never">
      <Image source={{ uri, headers }} style={{ width, height: height * 0.85 }} contentFit="contain"
        onLoadEnd={() => setLoading(false)} onError={(event) => { setLoading(false); setError(event.error) }} />
      {loading ? <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center' }} color="white" /> : null}
      {error ? <Text style={{ color: 'white', textAlign: 'center', padding: 16 }}>{error}</Text> : null}
    </ScrollView>
  )

  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <WebView source={{ uri, headers }} style={{ flex: 1 }} originWhitelist={['*']}
        onLoadEnd={() => setLoading(false)}
        onError={(event) => setError(event.nativeEvent.description)}
        onHttpError={(event) => setError(FILE_COPY.httpError(event.nativeEvent.statusCode))} />
      {loading ? <ActivityIndicator style={{ position: 'absolute', top: 24, alignSelf: 'center' }} /> : null}
      {error ? <Text style={{ color: C.red, padding: 16 }}>{error}</Text> : null}
    </View>
  )
}

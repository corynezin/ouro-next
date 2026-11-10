// Pair with a server: paste the link from `ouro pair`, or enter the address and code.
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { parsePairLink } from '../../core/accounts/pairing.ts'
import { accent } from '../../design/theme.ts'
import { useCore } from '../../navigation/coreContext.tsx'
import { NOTHING_USABLE_TO_PAIR_WITH, PairingGate, pairingTarget } from './model.ts'

export function PairScreen({ openedLink = null, onBack }: { openedLink?: string | null; onBack?: () => void }) {
  const core = useCore()
  const [link, setLink] = useState('')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [gate] = useState(() => new PairingGate())

  const pair = useCallback(async (target: { url: string; code: string } | null) => {
    if (!target) { setError(NOTHING_USABLE_TO_PAIR_WITH); return }
    await gate.run(async () => {
      setBusy(true)
      setError('')
      try {
        await core.pairAndActivate(target.url, target.code)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusy(false)
      }
    })
  }, [core, gate])

  // The link the app was opened with pairs at once. The root handles links; this form only receives them.
  useEffect(() => {
    if (!openedLink) return
    setLink(openedLink)
    void pair(parsePairLink(openedLink))
  }, [openedLink, pair])

  const pasteAndPair = async () => {
    if (busy) return
    const pasted = await Clipboard.getStringAsync()
    setLink(pasted)
    void pair(pairingTarget({ link: pasted, address, code }))
  }

  return (
    <View style={s.wrap}>
      <Text style={s.title}>Ouro</Text>
      <Text style={s.hint}>On your Mac run{'\n'}ouro pair{'\n'}and paste the link it prints.</Text>
      <TextInput style={s.input} placeholder="ouronext://pair?url=…&code=…" value={link} onChangeText={setLink}
        autoCapitalize="none" autoCorrect={false} />
      <Pressable style={s.secondary} disabled={busy} onPress={() => { void pasteAndPair() }}>
        <Text style={{ color: accent }}>Paste from clipboard and pair</Text>
      </Pressable>
      <Text style={s.or}>or</Text>
      <TextInput style={s.input} placeholder="server address (100.x.y.z:8790)" value={address} onChangeText={setAddress}
        autoCapitalize="none" autoCorrect={false} />
      <TextInput style={s.input} placeholder="code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} />
      <Pressable style={[s.button, { backgroundColor: accent }]} disabled={busy} onPress={() => { void pair(pairingTarget({ link, address, code })) }}>
        {busy ? <ActivityIndicator color="white" /> : <Text style={s.buttonText}>Pair</Text>}
      </Pressable>
      {!!error && <Text style={s.error}>{error}</Text>}
      {onBack ? <Pressable style={s.secondary} onPress={onBack}><Text style={{ color: accent }}>Back</Text></Pressable> : null}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 32, fontWeight: '700' },
  hint: { color: '#888', fontFamily: 'Menlo', fontSize: 13 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#999', borderRadius: 10, padding: 12, fontSize: 15 },
  or: { textAlign: 'center', color: '#888' },
  secondary: { alignItems: 'center', padding: 6 },
  button: { borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: '600', fontSize: 16 },
  error: { color: '#d33' },
})

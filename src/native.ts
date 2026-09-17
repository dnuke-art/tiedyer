// Native shell bridge. The web build never imports the Capacitor plugin packages:
// on iOS the runtime injects window.Capacitor before our scripts run, and only then
// do we dynamically import them (Vite splits that into its own chunk, so the
// website bundle is unchanged). Everything here is a no-op or a plain-web fallback
// when running as a website.

export const isNative = (): boolean => !!(window as any).Capacitor?.isNativePlatform?.();

/** Hand a file to the user: share sheet on iOS (which includes Save Image / Save to
 *  Files), a download link on the web. `data` is base64 without the data: prefix,
 *  or raw bytes. */
export async function deliverFile(name: string, data: string | Uint8Array, mime: string, title: string): Promise<void> {
  if (isNative()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'), import('@capacitor/share'),
    ]);
    const b64 = typeof data === 'string' ? data : bytesToBase64(data);
    const { uri } = await Filesystem.writeFile({ path: name, data: b64, directory: Directory.Cache });
    try { await Share.share({ title, files: [uri] }); } catch { /* user dismissed the sheet */ }
    return;
  }
  const a = document.createElement('a');
  if (typeof data === 'string') {
    a.href = `data:${mime};base64,${data}`;
  } else {
    a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  a.download = name;
  a.click();
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** Light haptic tick on iOS; nothing on the web. */
export function tap(): void {
  if (!isNative()) return;
  import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light })).catch(() => {});
}

export function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

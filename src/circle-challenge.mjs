// Runs one Circle challenge (PIN setup or approving a payment) in the customer's browser using Circle's web SDK.
// Sequence, as Circle documents it: create the SDK with the app id, call getDeviceId() straight away (it opens the session
// with Circle; without it execute() fails silently), then setAuthentication, then execute. The challenge, user token and
// encryption key come from the server for this customer only, are used once, and are never stored. The SDK is loaded on
// demand, so nothing is fetched or run unless a live provider returns a challenge.
export async function runCircleChallenge(challenge, loadSdk = () => import('@circle-fin/w3s-pw-web-sdk')) {
  const {appId, userToken, encryptionKey, challengeId} = challenge ?? {};
  if (![appId, userToken, encryptionKey, challengeId].every(v => typeof v === 'string' && v.length > 0)) throw new Error('The wallet step could not start.');
  const {W3SSdk} = await loadSdk();
  const sdk = new W3SSdk({appSettings: {appId}});
  const deviceId = await sdk.getDeviceId();
  if (typeof deviceId !== 'string' || deviceId.length === 0) throw new Error('The wallet step could not start (no device session).');
  sdk.setAuthentication({userToken, encryptionKey});
  return new Promise((resolve, reject) => {
    sdk.execute(challengeId, (error, result) => (error ? reject(new Error(error.message || 'The wallet step was not completed.')) : resolve(result)));
  });
}

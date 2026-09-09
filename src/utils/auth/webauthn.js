const {
  generateRegistrationOptions: registrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions: authenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const production = process.env.NODE_ENV === 'production';
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const origin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';
if (production && (!process.env.WEBAUTHN_RP_ID || !process.env.WEBAUTHN_ORIGIN)) {
  throw new Error('WEBAUTHN_RP_ID và WEBAUTHN_ORIGIN phải được cấu hình trong production');
}
const rpName = process.env.WEBAUTHN_RP_NAME || 'Chat App';

const generateRegistrationOptions = (user, credentials) => registrationOptions({
  rpName, rpID,
  userName: user.username,
  userID: user._id.toString(),
  attestationType: 'none',
  excludeCredentials: credentials.map(c => ({ id: c.credentialId, transports: c.transports })),
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
});
const generateAuthenticationOptions = credentials => authenticationOptions({
  rpID, userVerification: 'required',
  allowCredentials: credentials.map(c => ({ id: c.credentialId, transports: c.transports })),
});
const verifyRegistration = (response, expectedChallenge) => verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
const verifyAuthentication = (response, credential, expectedChallenge) => verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports }, requireUserVerification: true });

module.exports = { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistration, verifyAuthentication };

/**
 * Break-glass password reset — run on the server, never exposed over the web.
 *
 * This is the ultimate recovery hatch: it can reset ANY account (including the
 * last remaining owner) directly against the control database, using the same
 * password hashing as the app, so there's no way to be permanently locked out
 * of your own deployment.
 *
 * Usage (from the project root):
 *   npx tsx server/scripts/reset-password.ts <email> [new-password]
 *
 * If you omit the password, a strong one is generated and printed once.
 * The user's existing sessions are cleared, so they must log in afresh.
 */
import { randomBytes } from 'node:crypto';
import { initControl, setPasswordByEmail } from '../src/control';

function generatePassword(): string {
  // 18 url-safe chars — easy to copy, well above the 8-char minimum.
  return randomBytes(14).toString('base64url').slice(0, 18);
}

function main() {
  const [, , email, providedPassword] = process.argv;
  if (!email) {
    console.error('Usage: npx tsx server/scripts/reset-password.ts <email> [new-password]');
    process.exit(1);
  }
  const newPassword = providedPassword || generatePassword();
  try {
    initControl();
    const r = setPasswordByEmail(email, newPassword);
    console.log('\n✓ Password reset for', r.email, `(user #${r.user_id}).`);
    if (!providedPassword) {
      console.log('\n  New password:', newPassword);
      console.log('  Give this to the user and have them change it after logging in.\n');
    } else {
      console.log('  The new password you supplied is now active.\n');
    }
    console.log('  All existing sessions for this account were cleared.');
    process.exit(0);
  } catch (e: any) {
    console.error('\n✗ Could not reset password:', e.message, '\n');
    process.exit(1);
  }
}

main();

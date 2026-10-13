// Decrypts a backup downloaded from the panel (deploy/scripts/restore.sh runs this in the panel image).
//
//   BACKUP_PASSWORD=… node dist/cli/backup-decrypt.js <downloaded .tar.enc> <out .tar>
import { decryptFile, WrongBackupPassword } from "../backups/backup-crypto.js";

const [input, output] = process.argv.slice(2);
const password = process.env.BACKUP_PASSWORD ?? "";
if (!input || !output || !password) {
  console.error("usage: BACKUP_PASSWORD=… backup-decrypt <in> <out>");
  process.exit(2);
}
try {
  await decryptFile(input, output, password);
  console.log(`decrypted to ${output}`);
} catch (error) {
  console.error(error instanceof WrongBackupPassword ? "Wrong password, or the file is damaged." : (error as Error).message);
  process.exit(1);
}

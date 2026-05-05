export { PatientModule } from './patient.module';
export { PatientService, type PatientPiiInput, type DecryptedPatient } from './patient.service';
export {
  encryptString,
  decryptString,
  deriveTenantKey,
  lookupHash,
  type CipherBlob,
} from './pii.crypto';

import { unlockLmsStorage } from './lms-storage-lock.js';
try {
  const environment = process.argv[2];
  if (environment !== 'local' && environment !== 'test') throw new Error('Specify local or test.');
  const result = await unlockLmsStorage(environment);
  console.log(
    'Removed only the ' +
      result.environment +
      ' storage lock of exited process ' +
      result.formerPid +
      '. Storage and credentials retained.',
  );
} catch (error) {
  console.error(
    'LMS unlock refused: ' + (error instanceof Error ? error.message : 'unknown error') + '.',
  );
  process.exitCode = 1;
}

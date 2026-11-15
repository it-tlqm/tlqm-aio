import { verifyZipContents } from '../verified-zip.js';
import { HttpError } from '../security.js';
export async function verifyOrganizationZip(bytes: Uint8Array) {
  const fail = () => {
    throw new HttpError(400, 'ORGANIZATION_WORKBOOK_INVALID');
  };
  const names = await verifyZipContents(bytes, fail);
  if (!names.has('[Content_Types].xml')) fail();
}

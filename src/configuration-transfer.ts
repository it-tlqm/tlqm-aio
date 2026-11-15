import {
  ConfigurationTransferError,
  configurationDiff,
  configurationImportEvidence,
  makeConfigurationPackage,
  parseConfigurationPackage,
  remapConfiguration,
  signConfigurationReview,
  validateConfigurationReferences,
  verifyConfigurationReview,
} from './configuration-package.js';
import type {
  ConfigurationKind,
  ConfigurationReview,
  ReferenceOptions,
} from './configuration-package.js';
export type ConfigurationDescriptor = {
  tenantId: string;
  accountId: string;
  personId: string;
  revision: number;
  label: string;
  content: unknown;
  metadata: Record<string, unknown>;
};
export type ConfigurationAdapter = {
  read(): Promise<ConfigurationDescriptor>;
  normalize(value: unknown): unknown;
  options(): Promise<ReferenceOptions>;
  validate?(content: unknown): Promise<void>;
  trackImport?: boolean;
  write(review: ConfigurationReview): Promise<unknown>;
};
/** Stateless signed review binds content, actor, target and CAS revision; it grants no access. */
export class ConfigurationTransfer {
  constructor(
    readonly kind: ConfigurationKind,
    readonly target: string,
    readonly secret: string,
    readonly domain: string,
    readonly adapter: ConfigurationAdapter,
  ) {}
  async options() {
    await this.adapter.read();
    return this.adapter.options();
  }
  async export() {
    const state = await this.adapter.read();
    return makeConfigurationPackage(
      this.kind,
      state.label,
      this.adapter.normalize(state.content),
      await this.adapter.options(),
    );
  }
  async preview(file: unknown, mappings: unknown = []) {
    const state = await this.adapter.read(),
      pack = parseConfigurationPackage(file, this.kind),
      content = this.adapter.normalize(
        remapConfiguration(this.kind, this.adapter.normalize(pack.content), mappings),
      ),
      options = await this.adapter.options();
    validateConfigurationReferences(this.kind, content, options);
    await this.adapter.validate?.(content);
    const review = await signConfigurationReview(this.secret, this.domain, {
      kind: this.kind,
      target: this.target,
      tenantId: state.tenantId,
      accountId: state.accountId,
      personId: state.personId,
      revision: state.revision,
      content,
      metadata: state.metadata,
      ...(this.adapter.trackImport && {
        importEvidence: await configurationImportEvidence(pack, mappings as unknown[]),
      }),
    });
    return {
      review,
      changes: configurationDiff(this.adapter.normalize(state.content), content),
      backup: makeConfigurationPackage(
        this.kind,
        state.label,
        this.adapter.normalize(state.content),
        options,
      ),
      imported: makeConfigurationPackage(this.kind, pack.label, content, options),
    };
  }
  async apply(value: unknown) {
    const state = await this.adapter.read(),
      review = await verifyConfigurationReview(this.secret, this.domain, value);
    if (
      review.kind !== this.kind ||
      review.target !== this.target ||
      review.tenantId !== state.tenantId ||
      review.accountId !== state.accountId ||
      review.personId !== state.personId
    )
      throw new ConfigurationTransferError('CONFIGURATION_REVIEW_OWNER_MISMATCH', 403);
    const content = this.adapter.normalize(review.content);
    if (configurationDiff(review.content, content).length)
      throw new ConfigurationTransferError('CONFIGURATION_PREVIEW_STALE', 409);
    validateConfigurationReferences(this.kind, content, await this.adapter.options());
    await this.adapter.validate?.(content);
    return this.adapter.write(review);
  }
}

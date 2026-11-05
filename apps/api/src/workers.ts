// The Workers runtime types this package uses, imported by name. The package's
// default entry declares them globally, which would clash with Node's (tests run
// on Node).
export type {
  ExecutionContext,
  Hyperdrive,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2UploadedPart,
} from '@cloudflare/workers-types/index.ts';

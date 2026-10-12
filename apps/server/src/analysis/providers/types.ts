import type { AudioEvent, Box, FaceRegion, SceneNote, Transcript, Usage } from '@als/schema';
import type { z } from 'zod';

// The three provider interfaces from the plan, plus the frame region finder. Swapping a vendor means a new
// implementation of one of these; nothing else changes.

export interface TranscribeResult {
  transcript: Transcript & { events: AudioEvent[] };
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface Transcriber {
  transcribe(audioPath: string, options: { keyterms: string[]; durationSec: number }): Promise<TranscribeResult>;
}

export interface SceneContext {
  movieTitle?: string;
  sceneNote?: string;
  characterNames: string[];
}

export interface DescribeResult {
  notes: SceneNote[];
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface SceneDescriber {
  describe(videoPath: string, options: { durationSec: number; context: SceneContext }): Promise<DescribeResult>;
}

/** The move a frozen frame belongs to, so the finder knows what its subject is. */
export interface RegionContext {
  moveLabel: string;
  explanation: string;
  actorName?: string | undefined;
}

export interface FindRegionsResult {
  faces: FaceRegion[];
  subject?: Box;
  model: string;
  usage: Usage;
  costUsd: number;
}

/** Faces and the move's subject on one still frame (a JPEG), for placing its card. */
export interface RegionFinder {
  find(jpeg: Buffer, context: RegionContext): Promise<FindRegionsResult>;
}

/** Which call this is, so recorded responses can be replayed per call. */
export type AnalystCallName = 'speakers' | 'decisions' | 'annotate' | 'evaluate' | 'regenerate';

export interface AnalystCall<T> {
  name: AnalystCallName;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Stable instructions: role, rubric, voice and examples. Cached. */
  system: string;
  /** Shared context (the scene timeline). Cached, so later passes reuse it. */
  context: string;
  /** This call's task. */
  task: string;
  schema: z.ZodType<T>;
}

export interface AnalystResult<T> {
  output: T;
  /** The model that actually answered (a refused request may fall back to another). */
  model: string;
  usage: Usage;
  costUsd: number;
}

/** Claude with structured outputs: Pass A, Pass B, Pass C, speaker naming and Regenerate. */
export interface Analyst {
  run<T>(call: AnalystCall<T>): Promise<AnalystResult<T>>;
}

export interface Providers {
  transcriber: Transcriber;
  describer: SceneDescriber;
  analyst: Analyst;
  regions: RegionFinder;
}

/** A provider failed in a way the creator can act on (missing key, refusal, bad response). */
export class ProviderError extends Error {}

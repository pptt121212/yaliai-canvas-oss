import { z } from 'zod';
import { workflowSchema } from '@yali/workflow-schema';

export const canvasRoutingModeSchema = z.enum([
  'health_weighted_best',
  'priority_failover',
  'round_robin_failover',
  'weighted_round_robin',
  'least_recently_used',
  'smart_priority',
  'smart_failover',
  'fixed_provider',
]);

export const createWorkflowRunSchema = z.object({
  canvas_id: z.string().min(1),
  channel_id: z.string().optional(),
  execution_source: z.enum(['admin_managed', 'user_supplied', 'hybrid']).optional(),
  provider_source: z.enum(['admin_managed', 'user_supplied']).optional(),
  user_image_api_kind: z.enum(['images_endpoint', 'responses_endpoint']).optional(),
  user_api_base_url: z.string().url().optional(),
  user_images_generations_url: z.string().url().optional(),
  user_images_edits_url: z.string().url().optional(),
  user_api_key: z.string().optional(),
  user_chat_base_url: z.string().url().optional(),
  user_chat_api_key: z.string().optional(),
  preferred_auth_mode: z.enum(['bearer', 'x-api-key']).optional(),
  user_chat_fallback_mode: z.enum(['platform_fallback', 'strict_user']).optional(),
  execution_owner_lock: z.string().optional(),
  line_group: z.string().optional(),
  workflow: workflowSchema.optional(),
  nodes: z.array(z.any()).optional(),
  edges: z.array(z.any()).optional(),
  routing_mode: canvasRoutingModeSchema.optional(),
  internal_tenant_id: z.string().optional(),
  internal_api_key_id: z.string().optional(),
});

export type CanvasWorkflowPayload = z.infer<typeof createWorkflowRunSchema>;

export type CanvasNode = {
  id: string;
  type: string;
  data?: Record<string, any>;
  position?: { x?: number; y?: number };
  [key: string]: unknown;
};

export type CanvasEdge = {
  id?: string;
  source: string;
  target: string;
};

export type CanvasGeneratedItem = {
  job_id: string;
  task_id: string;
  node_id: string;
  status: 'done' | 'failed' | 'running';
  image_url: string;
  reference_url?: string;
  download_url?: string;
  prompt?: string;
  batch_item?: Record<string, unknown> | null;
  name?: string;
  image_category?: string;
  goal?: string;
  reference_usage?: string;
  script_text?: string;
  shot_script?: string;
  index?: number;
};

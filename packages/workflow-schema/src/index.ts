import { z } from 'zod';

export const workflowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()).default({})
});

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string()
});

export const workflowSchema = z.object({
  id: z.string(),
  version: z.string(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema)
});

export type Workflow = z.infer<typeof workflowSchema>;

export const defaultWorkflow: Workflow = {
  id: 'bootstrap-workflow',
  version: '0.1.0',
  nodes: [],
  edges: []
};


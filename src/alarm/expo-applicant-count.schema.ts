import { z } from 'zod';

export const expoApplicantCountSchema = z.object({
  eventId: z.string().min(1),
  version: z.literal(1),
  expoId: z.string().min(1),
  expoTitle: z.string().min(1),
  applicationPerson: z.number().int().nonnegative(),
});

export type ExpoApplicantCountEvent = z.infer<typeof expoApplicantCountSchema>;

-- The step a job last entered (its Workflow step name). Dev uses it to restart a job
-- orphaned by a killed `wrangler dev` from that step, reusing the finished ones.
alter table app.jobs add column step text;

-- Pending tasks preserve their organization rule; an audited manual reassignment clears it.
ALTER TABLE workflow_tasks ADD COLUMN organization_rule jsonb;
ALTER TABLE workflow_tasks ADD CONSTRAINT organization_rule_shape CHECK (
 organization_rule IS NULL OR (jsonb_typeof(organization_rule)='object' AND organization_rule->>'kind' IN ('manager','unit-head') AND organization_rule ? 'ownerPersonId')
);

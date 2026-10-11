## AC-GATES — Sequential Sol then Terra
**Clauses:** AC-GATES, AC-GATES-record, AC-GATES-driver

The Terra gate never starts before the Sol gate returns `MERGE`. In a pull-request run, a Sol result whose only open findings are Minors recorded under CL-D85 counts as `MERGE` for that prerequisite (CL-D85).

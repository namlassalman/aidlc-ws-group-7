# Unit Split: Radiology Roster

Who builds each Unit. The walking skeleton comes first; the five feature Units follow it.

| Unit | Owner | Role | What it covers |
|---|---|---|---|
| Walking skeleton | Wafi | Delivery and architecture | Every shared file the feature Units need: the package manifest, the Express app with each feature's router mounted, the Lambda handler and local server, auth and error middleware, every DynamoDB table and the table helpers, the rule checker, the whole CDK stack, the roster page shell, the seed and smoke scripts, and the test setup. Built and deployed first. |
| Doctors | Salman | Product | Add, edit and deactivate doctors, with grade, modalities and maximum hours. |
| Duties | Wei Min | Quality | The shifts that need cover (AM, PM, overnight CALL), by date and modality. |
| Leave | Kenneth | SecOps | Doctors request leave; the coordinator approves or rejects it. |
| Rules | Kelvin | Design | The rules the roster follows, such as rest after a call. |
| Roster | Salman | Product | Generate a draft roster for a period, review the gaps, publish it. This feature owns the roster page. |

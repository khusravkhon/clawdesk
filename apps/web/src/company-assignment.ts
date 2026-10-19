import type { AssignAgentDepartmentRequest, CompanyDto, UpdateDepartmentRequest } from "@clawdesk/shared";

type CompanyPort = {
  get(): Promise<CompanyDto>;
  update(id: string, body: UpdateDepartmentRequest): Promise<unknown>;
  assignAgent(id: string, body: AssignAgentDepartmentRequest): Promise<unknown>;
};
export class DepartmentLinkError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Retry only the assignment, using fresh revisions; never creates another agent. */
export async function linkDepartmentAgent(company: CompanyPort, departmentId: string, role: "manager" | "member", agentId: string): Promise<void> {
  const snapshot = await company.get();
  const department = snapshot.departments.find((item) => item.id === departmentId);
  if (!department) throw new DepartmentLinkError("department_missing");
  const agent = snapshot.agents.find((item) => item.id === agentId);
  if (!agent) throw new DepartmentLinkError("agent_invalid");
  if (role === "manager" && department.managerAgentId === agentId) return;
  if (role === "member" && agent.departmentId === departmentId) return;
  if (department.archived) throw new DepartmentLinkError("department_archived");
  if (agent.departmentId && agent.departmentId !== departmentId) throw new DepartmentLinkError("agent_assigned");
  if (role === "member") await company.assignAgent(agentId, { departmentId, revision: agent.revision });
  else {
    if (department.managerAgentId) throw new DepartmentLinkError("department_has_manager");
    await company.update(departmentId, { name: department.name, description: department.description, archived: false, revision: department.revision, managerAgentId: agentId });
  }
}

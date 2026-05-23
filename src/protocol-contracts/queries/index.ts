export interface AgentInfoQuery {
  type: "AgentInfoQuery";
}

export interface ResourceListQuery {
  type: "ResourceListQuery";
}

export interface TaskInfoQuery {
  type: "TaskInfoQuery";
  taskId: string;
}

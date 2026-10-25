import { describe, expect, it } from "vitest";
import { validateWorkflowMarkdown } from "./workflow-markdown.js";

const header = `# 工作流：测试流程

## 元信息

- key: test-flow
- version: 1
- description: deterministic parser fixture

## 节点
`;

describe("workflow markdown validation", () => {
  it("parses a valid mixed workflow", () => {
    const result = validateWorkflowMarkdown(`${header}
### 开发

- id: development
- type: task
- executor: agent:backend
- description: implement

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- development -> release
`);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.graph?.nodes.map((node) => node.id)).toEqual([
      "development",
      "release",
    ]);
    expect(result.graph?.startNodeIds).toEqual(["development"]);
  });

  it("rejects dangling references and repeated ids", () => {
    const result = validateWorkflowMarkdown(`${header}
### A

- id: same
- type: task
- executor: user:alice

### B

- id: same
- type: task
- executor: user:bob

## 连接

- same -> missing
`);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["duplicate_node_id", "unknown_edge_node"]),
    );
  });

  it("rejects a cycle without a break condition", () => {
    const result = validateWorkflowMarkdown(`${header}
### A

- id: a
- type: task
- executor: user:alice

### B

- id: b
- type: task
- executor: user:bob

## 连接

- a -> b
- b -> a
`);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "uncontrolled_cycle" }),
    );
  });

  it("requires a branch on decision nodes", () => {
    const result = validateWorkflowMarkdown(`${header}
### Decide

- id: decide
- type: decision
- executor: system:rules

### End

- id: end
- type: service
- executor: system:end

## 连接

- decide -> end
`);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "decision_branch_required" }),
    );
  });
});

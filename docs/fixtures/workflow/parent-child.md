# 工作流：带子流程的交付

## 元信息

- key: parent-child
- version: 1
- description: 复杂方案走子流程
- variable: complexity = 8

## 节点

### 方案判断

- id: complexity
- type: decision
- executor: system:rules

### 复杂方案评审

- id: complex-review
- type: subworkflow
- executor: system:workflow
- subworkflow: complex-review
- subworkflow-version: 1

### 标准开发

- id: standard-development
- type: task
- executor: agent:backend-agent
- responsible: user:flow-owner

### 归档

- id: archive
- type: service
- executor: system:workflow

## 连接

- complexity -> complex-review [condition: complexity >= 8]
- complexity -> standard-development [default]
- complex-review -> archive
- standard-development -> archive

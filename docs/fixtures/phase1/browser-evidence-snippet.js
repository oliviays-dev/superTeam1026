// Paste into the Pluginmax page DevTools Console after replacing taskId.
(() => {
  const taskId = "<TASK_ID>";
  const token = window.localStorage.getItem("pluginmax.collab.token");
  if (!token) throw new Error("pluginmax.collab.token is missing");

  return fetch(
    `/api/collab/tasks/execution?taskId=${encodeURIComponent(taskId)}`,
    {
      credentials: "same-origin",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  )
    .then((response) => {
      if (!response.ok) {
        throw new Error(`execution request failed: ${response.status}`);
      }
      return response.json();
    })
    .then((body) => {
      console.log(JSON.stringify(body, null, 2));
      return body;
    });
})();

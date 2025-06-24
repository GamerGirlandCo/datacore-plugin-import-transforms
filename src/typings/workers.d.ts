declare module "worker/transform.worker" {
	const WorkerFactory: new() => Worker;
	export default WorkerFactory;
}

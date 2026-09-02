/** 运行时的错误类型。**平台维护，不要改。** */

/**
 * 业务错误。抛它会得到一个受控的响应；抛其它任何东西都会变成 500，
 * 详情只进日志、不进响应体（栈里常有内部路径与 SQL）。
 */
export class AppError extends Error {
    readonly status: number;
    readonly code: string;
    readonly detail: unknown;

    constructor(status: number, code: string, message?: string, detail?: unknown) {
        super(message ?? code);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

export const badRequest = (code: string, msg?: string) => new AppError(400, code, msg);
export const unauthorized = (code: string, msg?: string) => new AppError(401, code, msg);
export const forbidden = (code: string, msg?: string) => new AppError(403, code, msg);
export const notFound = (code: string, msg?: string) => new AppError(404, code, msg);

/**
 * 缺少资源绑定时抛这个，而不是让租户代码撞上 `undefined.prepare is not a function`
 * —— 后者的报错完全指不到真正的原因（manifest 里没声明）。
 */
export function missingResource(name: string, manifestPath: string): AppError {
    return new AppError(
        500,
        'RESOURCE_NOT_DECLARED',
        `这个应用没有声明 ${name}。在 manifest.json 里把 ${manifestPath} 设为 true，` +
        `然后重新发布一个版本。（本地开发还需要 backend/wrangler.jsonc 里有对应的 binding。）`
    );
}
